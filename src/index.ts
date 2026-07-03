#!/usr/bin/env node
/**
 * pico8-mcp — MCP server for interactive input/output control of PICO-8 carts.
 *
 * Runs real PICO-8 headless (`pico8 -x`) with a Lua harness injected into a
 * temp copy of the cart. The harness turns the game loop into a lockstep
 * driven over stdin/stdout (see src/harness.ts), so an LLM can press buttons,
 * advance frames deterministically, look at pixel-perfect screenshots and
 * read game variables.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Pico8Session, bootCheck } from "./session.js";
import { framebufferToPng } from "./png.js";
import { buttonsToMask, maskToButtons } from "./buttons.js";

const sessions = new Map<string, Pico8Session>();

function getSession(id?: string): Pico8Session {
  if (id) {
    const s = sessions.get(id);
    if (!s) throw new Error(`no session "${id}" (active: ${[...sessions.keys()].join(", ") || "none"})`);
    return s;
  }
  const live = [...sessions.values()].filter((s) => s.alive);
  if (live.length === 0) throw new Error("no active session — call pico8_boot first");
  return live[live.length - 1];
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

async function screenshotContent(s: Pico8Session, scale: number): Promise<Content> {
  const { screenPal, fb } = await s.screen();
  const png = framebufferToPng(fb, screenPal, scale);
  return { type: "image", data: png.toString("base64"), mimeType: "image/png" };
}

function statusText(s: Pico8Session, extra: string[] = []): string {
  const secs = (s.frame / s.hz).toFixed(2);
  const lines = [
    `session=${s.id} frame=${s.frame} (${secs}s at ${s.hz}fps) alive=${s.alive}`,
    ...extra,
  ];
  const console_ = s.alive ? s.drainConsole() : [];
  if (console_.length) lines.push(`console output:`, ...console_.map((l) => `  ${l}`));
  return lines.join("\n");
}

function errorResult(err: unknown): { content: Content[]; isError: true } {
  return {
    content: [{ type: "text", text: `error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}

const server = new McpServer({ name: "pico8-mcp", version: "0.1.0" });

const buttonsSchema = z
  .array(z.enum(["left", "right", "up", "down", "o", "x"]))
  .describe('buttons to HOLD during the frames: "o" = btn(4) (usually jump), "x" = btn(5) (usually dash)');
const scaleSchema = z.number().int().min(1).max(4).default(2).describe("screenshot upscale factor (128*scale px)");
const sessionIdSchema = z.string().optional().describe("session id; defaults to the most recent live session");

server.registerTool(
  "pico8_boot",
  {
    title: "Boot a PICO-8 cart",
    description:
      "Start a PICO-8 cart under interactive lockstep control. The cart is copied to /tmp with a control " +
      "harness injected (the original file is never modified). Game time is FROZEN until you call " +
      "pico8_step/pico8_play. Returns the session id and a screenshot of the boot state. " +
      "Requires the cart to use _update/_update60 and btn/btnp (standard carts do).",
    inputSchema: {
      cart_path: z.string().describe("path to the .p8 text cartridge"),
      seed: z.number().int().optional().describe("call srand(seed) at load for deterministic rnd()"),
      screenshot: z.boolean().default(true),
      scale: scaleSchema,
    },
  },
  async ({ cart_path, seed, screenshot, scale }) => {
    try {
      const s = await Pico8Session.boot(cart_path, { seed });
      sessions.set(s.id, s);
      const extra = [`booted ${cart_path} (update rate: ${s.hz}fps)`];
      if (s.bootConsole.length) extra.push("boot output:", ...s.bootConsole.map((l) => `  ${l}`));
      const content: Content[] = [{ type: "text", text: statusText(s, extra) }];
      if (screenshot) content.push(await screenshotContent(s, scale));
      return { content };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "pico8_step",
  {
    title: "Hold buttons and advance frames",
    description:
      "Hold a set of buttons and advance the game by N frames (deterministic lockstep, runs much faster " +
      "than real time). Buttons are held for ALL N frames, then remain held until the next step. " +
      "btnp() fires only on the first frame of a new press — to press a button twice, release it in between " +
      "(step with buttons:[]). Returns a screenshot after the last frame.",
    inputSchema: {
      session_id: sessionIdSchema,
      buttons: buttonsSchema.default([]),
      frames: z.number().int().min(1).max(36000).default(1).describe("number of game updates to run"),
      screenshot: z.boolean().default(true),
      scale: scaleSchema,
    },
  },
  async ({ session_id, buttons, frames, screenshot, scale }) => {
    try {
      const s = getSession(session_id);
      await s.step(buttonsToMask(buttons), frames);
      const held = buttons.length ? buttons.join("+") : "(none)";
      const content: Content[] = [{ type: "text", text: statusText(s, [`held ${held} for ${frames} frame(s)`]) }];
      if (screenshot) content.push(await screenshotContent(s, scale));
      return { content };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "pico8_play",
  {
    title: "Play a scripted input sequence",
    description:
      "Run a sequence of {buttons, frames} steps in one call (e.g. walk right 30 frames, jump, dash). " +
      "More efficient than many pico8_step calls. Returns a screenshot after the final step.",
    inputSchema: {
      session_id: sessionIdSchema,
      steps: z
        .array(
          z.object({
            buttons: buttonsSchema.default([]),
            frames: z.number().int().min(1).max(36000).default(1),
          }),
        )
        .min(1)
        .max(200),
      screenshot: z.boolean().default(true),
      scale: scaleSchema,
    },
  },
  async ({ session_id, steps, screenshot, scale }) => {
    try {
      const s = getSession(session_id);
      const desc: string[] = [];
      for (const st of steps) {
        await s.step(buttonsToMask(st.buttons), st.frames);
        desc.push(`${st.buttons.length ? st.buttons.join("+") : "none"}x${st.frames}`);
      }
      const content: Content[] = [
        { type: "text", text: statusText(s, [`played: ${desc.join(" | ")}`]) },
      ];
      if (screenshot) content.push(await screenshotContent(s, scale));
      return { content };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "pico8_screen",
  {
    title: "Screenshot the current frame",
    description: "Return a pixel-perfect PNG of the current 128x128 PICO-8 screen (post-draw).",
    inputSchema: { session_id: sessionIdSchema, scale: scaleSchema },
  },
  async ({ session_id, scale }) => {
    try {
      const s = getSession(session_id);
      return { content: [await screenshotContent(s, scale)] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "pico8_read",
  {
    title: "Read game globals",
    description:
      'Read Lua globals from the running cart by dotted path, e.g. ["player.x","player.y","deaths","win"]. ' +
      "Tables are serialized one level deep. Useful to verify game state precisely instead of eyeballing pixels.",
    inputSchema: {
      session_id: sessionIdSchema,
      globals: z.array(z.string()).min(1).max(64).describe('dotted paths, e.g. "p.x" or "objects.1.type"'),
    },
  },
  async ({ session_id, globals }) => {
    try {
      const s = getSession(session_id);
      const vals = await s.readGlobals(globals);
      const text = Object.entries(vals)
        .map(([k, v]) => `${k} = ${v}`)
        .join("\n");
      return { content: [{ type: "text", text: text || "(no values)" }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "pico8_peek",
  {
    title: "Read PICO-8 memory",
    description:
      "Hex dump of PICO-8 RAM. Useful addresses: 0x6000 framebuffer, 0x5f00 draw state, 0x0 sprite sheet, " +
      "0x2000 map, 0x5f80 GPIO (used by the harness).",
    inputSchema: {
      session_id: sessionIdSchema,
      addr: z.union([z.number().int(), z.string()]).describe('address, e.g. 24576 or "0x6000"'),
      len: z.number().int().min(1).max(4096).default(64),
    },
  },
  async ({ session_id, addr, len }) => {
    try {
      const s = getSession(session_id);
      const a = typeof addr === "string" ? parseInt(addr, addr.trim().startsWith("0x") ? 16 : 10) : addr;
      if (!Number.isFinite(a)) throw new Error(`bad address: ${addr}`);
      const data = await s.peek(a, len);
      const lines: string[] = [];
      for (let o = 0; o < data.length; o += 16) {
        const slice = data.subarray(o, o + 16);
        lines.push(
          `0x${(a + o).toString(16).padStart(4, "0")}: ${[...slice].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`,
        );
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "pico8_reset",
  {
    title: "Reset the cart",
    description:
      "Kill and restart the session's cart from the original file (re-reads it from disk, so cart edits are " +
      "picked up). Frame counter returns to 0.",
    inputSchema: { session_id: sessionIdSchema, screenshot: z.boolean().default(true), scale: scaleSchema },
  },
  async ({ session_id, screenshot, scale }) => {
    try {
      const s = getSession(session_id);
      await s.reset();
      const content: Content[] = [{ type: "text", text: statusText(s, ["reset: cart reloaded from disk"]) }];
      if (screenshot) content.push(await screenshotContent(s, scale));
      return { content };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "pico8_shutdown",
  {
    title: "Shut down a session",
    description: "Stop the PICO-8 process of a session (or the default session).",
    inputSchema: { session_id: sessionIdSchema },
  },
  async ({ session_id }) => {
    try {
      const s = getSession(session_id);
      await s.shutdown();
      sessions.delete(s.id);
      return { content: [{ type: "text", text: `session ${s.id} shut down` }] };
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "pico8_sessions",
  {
    title: "List sessions",
    description: "List active PICO-8 sessions.",
    inputSchema: {},
  },
  async () => {
    const rows = [...sessions.values()].map(
      (s) => `${s.id}: ${s.cartPath} frame=${s.frame} hz=${s.hz} alive=${s.alive}`,
    );
    return { content: [{ type: "text", text: rows.join("\n") || "(no sessions)" }] };
  },
);

server.registerTool(
  "pico8_boot_check",
  {
    title: "Plain boot check (no harness)",
    description:
      "Run the UNMODIFIED cart with `pico8 -x` for a few seconds and report whether it boots cleanly " +
      "(RUNNING with no syntax/runtime error). Equivalent of `timeout N pico8 -x cart.p8`.",
    inputSchema: {
      cart_path: z.string(),
      seconds: z.number().int().min(2).max(30).default(8),
    },
  },
  async ({ cart_path, seconds }) => {
    try {
      const r = await bootCheck(cart_path, seconds);
      return {
        content: [{ type: "text", text: `${r.ok ? "OK" : "FAIL"}: ${r.verdict}\n--- output ---\n${r.output}` }],
        ...(r.ok ? {} : { isError: true as const }),
      };
    } catch (err) {
      return errorResult(err);
    }
  },
);

function cleanup(): void {
  for (const s of sessions.values()) s.kill();
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    cleanup();
    process.exit(0);
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("pico8-mcp ready (stdio)");
