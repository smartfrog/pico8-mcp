import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { StreamParser, type StreamEvent } from "./stream.js";
import { injectHarness } from "./harness.js";

const ROOT = "/tmp/pico8-mcp";
const HOME = join(ROOT, "home");

export interface SessionOptions {
  seed?: number;
  pico8Bin?: string;
}

const isLine = (ev: StreamEvent): ev is Extract<StreamEvent, { type: "line" }> => ev.type === "line";
const isErrorLine = (l: string) => /(syntax error|runtime error|could not load|unable to load)/i.test(l);

let seq = 0;

export class Pico8Session {
  readonly id: string;
  readonly cartPath: string;
  readonly seed?: number;
  hz = 30;
  frame = 0;
  bootConsole: string[] = [];

  private readonly bin: string;
  private readonly workDir: string;
  private readonly injectedPath: string;
  private proc!: ChildProcess;
  private parser!: StreamParser;
  private stderrTail: string[] = [];
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(cartPath: string, opts: SessionOptions) {
    this.id = `s${++seq}`;
    this.cartPath = resolve(cartPath);
    this.seed = opts.seed;
    this.bin = opts.pico8Bin ?? process.env.PICO8_BIN ?? "pico8";
    this.workDir = join(ROOT, this.id);
    this.injectedPath = join(this.workDir, "cart.p8");
  }

  static async boot(cartPath: string, opts: SessionOptions = {}): Promise<Pico8Session> {
    const s = new Pico8Session(cartPath, opts);
    await s.spawnAndWaitBoot();
    return s;
  }

  get alive(): boolean {
    return this.exitInfo === null;
  }

  private async spawnAndWaitBoot(): Promise<void> {
    // (re-)read the original cart so edits are picked up on reset
    const text = readFileSync(this.cartPath, "utf8");
    const injected = injectHarness(text, this.seed);
    mkdirSync(this.workDir, { recursive: true });
    mkdirSync(HOME, { recursive: true });
    writeFileSync(this.injectedPath, injected);

    this.parser = new StreamParser();
    this.stderrTail = [];
    this.exitInfo = null;
    this.frame = 0;

    this.proc = spawn(this.bin, ["-home", HOME, "-x", this.injectedPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout!.on("data", (d: Buffer) => this.parser.feed(d));
    this.proc.stderr!.on("data", (d: Buffer) => {
      for (const l of d.toString().split("\n")) {
        if (l.trim()) this.stderrTail.push(l);
      }
      if (this.stderrTail.length > 50) this.stderrTail.splice(0, this.stderrTail.length - 50);
    });
    this.proc.stdin!.on("error", () => {}); // EPIPE after death
    this.proc.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      const tail = [...this.parser.console.slice(-5), ...this.stderrTail.slice(-5)];
      this.parser.close(
        new Error(
          `pico8 process exited (code=${code} signal=${signal})` +
            (tail.length ? `\nlast output:\n${tail.join("\n")}` : ""),
        ),
      );
    });
    this.proc.on("error", (err) => {
      this.exitInfo = { code: null, signal: null };
      this.parser.close(new Error(`failed to spawn ${this.bin}: ${err.message}`));
    });

    // boot: expect "@rdy <hz>" then the first "@f <frame>" ack (or an error line)
    const bootPred = (ev: StreamEvent) =>
      isLine(ev) && (ev.line.startsWith("@rdy") || isErrorLine(ev.line));
    const rdy = await this.parser.waitFor(bootPred, 25000, "boot (@rdy)");
    if (isLine(rdy) && !rdy.line.startsWith("@rdy")) {
      await this.sleep(150); // let follow-up error lines arrive
      const ctx = this.parser.console.slice(-8).join("\n");
      this.kill();
      throw new Error(`cart failed to boot: ${rdy.line}${ctx ? `\n${ctx}` : ""}`);
    }
    this.hz = parseInt((rdy as { line: string }).line.split(" ")[1], 10) || 30;
    await this.waitAck(10000);
    this.bootConsole = this.parser.drainConsole();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private send(op: string, a = 0, b = 0, payload?: string): void {
    if (!this.alive) throw new Error(`session ${this.id}: pico8 process is not running`);
    const hex3 = (n: number) => (n & 0xfff).toString(16).padStart(3, "0");
    const header = `${op}${hex3(a)}${hex3(b)}\n`;
    this.proc.stdin!.write(payload !== undefined ? header + payload : header);
  }

  private async waitAck(timeoutMs: number): Promise<number> {
    const ev = await this.parser.waitFor(
      (e) => isLine(e) && (e.line.startsWith("@f ") || isErrorLine(e.line)),
      timeoutMs,
      "frame ack (@f)",
    );
    const line = (ev as { line: string }).line;
    if (!line.startsWith("@f ")) {
      await this.sleep(150);
      throw new Error(`cart error: ${line}\n${this.parser.console.slice(-8).join("\n")}`);
    }
    this.frame = parseInt(line.slice(3), 10) || 0;
    return this.frame;
  }

  /** Serialize all commands on this session. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  /** Hold `mask` buttons and advance `frames` game updates. Resolves post-draw. */
  step(mask: number, frames: number): Promise<number> {
    if (frames < 1) throw new Error("frames must be >= 1");
    return this.enqueue(async () => {
      let left = frames;
      while (left > 0) {
        const n = Math.min(left, 4095);
        this.send("f", mask, n);
        await this.waitAck(10000 + n * 20);
        left -= n;
      }
      return this.frame;
    });
  }

  /** Dump palette state + framebuffer. */
  screen(): Promise<{ screenPal: Uint8Array; fb: Uint8Array }> {
    return this.enqueue(async () => {
      this.send("s");
      const ev = await this.parser.waitFor((e) => e.type === "bin" && e.tag === "fb", 10000, "framebuffer");
      const data = (ev as Extract<StreamEvent, { type: "bin" }>).data;
      if (data.length !== 8256) throw new Error(`framebuffer dump: expected 8256 bytes, got ${data.length}`);
      return {
        screenPal: new Uint8Array(data.subarray(16, 32)), // 0x5f10..0x5f1f
        fb: new Uint8Array(data.subarray(64)),
      };
    });
  }

  /** Read global variables by dotted path (e.g. "player.x"). */
  readGlobals(names: string[]): Promise<Record<string, string>> {
    if (names.length === 0) return Promise.resolve({});
    const payload = names.join(",");
    if (payload.length > 4000) throw new Error("too many/long global names (max 4000 chars)");
    if (/[\n\r]/.test(payload)) throw new Error("global names must not contain newlines");
    return this.enqueue(async () => {
      this.send("g", payload.length, 0, payload);
      const head = await this.parser.waitFor(
        (e) => isLine(e) && e.line.startsWith("@vs "),
        10000,
        "globals reply (@vs)",
      );
      const count = parseInt((head as { line: string }).line.slice(4), 10);
      const out: Record<string, string> = {};
      for (let i = 1; i <= count; i++) {
        const ev = await this.parser.waitFor(
          (e) => isLine(e) && e.line.startsWith(`@v ${i} `),
          5000,
          `global value ${i}`,
        );
        out[names[i - 1] ?? `#${i}`] = (ev as { line: string }).line.slice(`@v ${i} `.length);
      }
      return out;
    });
  }

  /** Read `len` bytes of PICO-8 memory starting at `addr`. */
  peek(addr: number, len: number): Promise<Buffer> {
    if (addr < 0 || addr > 0xffff) throw new Error("addr must be 0..0xffff");
    if (len < 1 || len > 16384) throw new Error("len must be 1..16384");
    const payload = `${addr},${len}`;
    return this.enqueue(async () => {
      this.send("p", payload.length, 0, payload);
      const ev = await this.parser.waitFor((e) => e.type === "bin" && e.tag === "m", 10000, "memory dump");
      return (ev as Extract<StreamEvent, { type: "bin" }>).data;
    });
  }

  /** Kill and respawn from the (re-read) original cart. */
  reset(): Promise<void> {
    return this.enqueue(async () => {
      this.kill();
      await this.sleep(100);
      await this.spawnAndWaitBoot();
    });
  }

  drainConsole(): string[] {
    return this.parser.drainConsole();
  }

  async shutdown(): Promise<void> {
    if (this.alive) {
      try {
        this.send("q");
      } catch {
        /* already dead */
      }
      const deadline = Date.now() + 2000;
      while (this.alive && Date.now() < deadline) await this.sleep(50);
    }
    this.kill();
  }

  kill(): void {
    if (this.proc && this.exitInfo === null) {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
}

/** Plain boot check on the ORIGINAL cart (no harness), like the benchmark does. */
export async function bootCheck(
  cartPath: string,
  seconds: number,
  pico8Bin?: string,
): Promise<{ ok: boolean; verdict: string; output: string }> {
  const bin = pico8Bin ?? process.env.PICO8_BIN ?? "pico8";
  mkdirSync(HOME, { recursive: true });
  const proc = spawn(bin, ["-home", HOME, "-x", resolve(cartPath)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  proc.stderr!.on("data", (d: Buffer) => (out += d.toString()));
  const exited = await new Promise<boolean>((res) => {
    const t = setTimeout(() => res(false), seconds * 1000);
    proc.on("exit", () => {
      clearTimeout(t);
      res(true);
    });
  });
  if (!exited) proc.kill("SIGKILL");
  const running = /^RUNNING:/m.test(out);
  const errLine = out.split("\n").find((l) => isErrorLine(l));
  const ok = running && !errLine && !exited;
  let verdict: string;
  if (!running) verdict = "did not reach RUNNING state";
  else if (errLine) verdict = `error detected: ${errLine.trim()}`;
  else if (exited) verdict = "cart exited on its own (unexpected for a game loop)";
  else verdict = `clean boot: still running after ${seconds}s with no errors`;
  return { ok, verdict, output: out.trim() };
}
