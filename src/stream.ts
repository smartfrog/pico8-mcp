/**
 * Parser for the mixed text/binary stdout stream coming from the harness.
 * Text lines end with \n. A line "@fb <n>" or "@m <n>" announces that the
 * next <n> raw bytes are a binary block.
 */

export type StreamEvent =
  | { type: "line"; line: string }
  | { type: "bin"; tag: string; data: Buffer };

type Pred = (ev: StreamEvent) => boolean;

interface Waiter {
  pred: Pred;
  resolve: (ev: StreamEvent) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class StreamParser {
  private buf: Buffer = Buffer.alloc(0);
  private binWant = 0;
  private binTag = "";
  private events: StreamEvent[] = [];
  private waiters: Waiter[] = [];
  private closed: Error | null = null;

  /** Cart's own printh output (lines not starting with "@"), ring buffer. */
  readonly console: string[] = [];
  private static readonly CONSOLE_MAX = 500;

  feed(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.binWant > 0) {
        if (this.buf.length < this.binWant) return;
        const data = this.buf.subarray(0, this.binWant);
        this.buf = this.buf.subarray(this.binWant);
        this.binWant = 0;
        this.push({ type: "bin", tag: this.binTag, data });
        continue;
      }
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0) return;
      const line = this.buf.subarray(0, nl).toString("latin1").replace(/\r$/, "");
      this.buf = this.buf.subarray(nl + 1);
      const mFb = /^@(fb|m) (\d+)$/.exec(line);
      if (mFb) {
        this.binTag = mFb[1];
        this.binWant = parseInt(mFb[2], 10);
        if (this.binWant === 0) this.push({ type: "bin", tag: this.binTag, data: Buffer.alloc(0) });
        continue;
      }
      if (!line.startsWith("@")) {
        this.console.push(line);
        if (this.console.length > StreamParser.CONSOLE_MAX) this.console.shift();
      }
      this.push({ type: "line", line });
    }
  }

  /** Signal that the stream ended (process exit); pending waiters reject. */
  close(err: Error): void {
    this.closed = err;
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  private push(ev: StreamEvent): void {
    this.events.push(ev);
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      const idx = this.events.findIndex(w.pred);
      if (idx >= 0) {
        const found = this.events[idx];
        this.events.splice(0, idx + 1);
        this.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(found);
        return;
      }
    }
    // keep the backlog bounded (older unconsumed events are dropped)
    if (this.events.length > 2000) this.events.splice(0, this.events.length - 2000);
  }

  waitFor(pred: Pred, timeoutMs: number, what: string): Promise<StreamEvent> {
    const idx = this.events.findIndex(pred);
    if (idx >= 0) {
      const ev = this.events[idx];
      this.events.splice(0, idx + 1);
      return Promise.resolve(ev);
    }
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        pred,
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(w);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error(`timeout after ${timeoutMs}ms waiting for ${what}`));
        }, timeoutMs),
      };
      this.waiters.push(w);
    });
  }

  drainConsole(): string[] {
    return this.console.splice(0);
  }
}
