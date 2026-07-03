# pico8-mcp

MCP server that lets an LLM **play PICO-8 carts interactively**: press buttons,
advance frames deterministically, look at pixel-perfect screenshots, and read
game variables — against the *real* PICO-8 binary, headless.

## How it works

```
LLM ⇄ MCP (stdio) ⇄ pico8-mcp ⇄ pipes ⇄ pico8 -x cart_instrumented.p8
```

- The cart is copied to `/tmp/pico8-mcp/<session>/` and a small Lua harness is
  injected at the end of its `__lua__` section (the original file is never
  touched). The harness shadows `btn`/`btnp` and replaces `_update`/`_update60`
  with a command loop.
- Input rides on PICO-8's `serial(0x804, …)` stdin channel. On desktop PICO-8
  (0.2.7) this read has **fread semantics: it blocks until exactly `len` bytes
  arrive**. The driver therefore speaks fixed-size 8-byte packets
  (`<op:1><a:3 hex><b:3 hex>\n`), which freezes the engine between commands and
  gives perfect lockstep — batched frames run at host speed (~600 game frames
  in <30 ms), not real time.
- Output rides on `printh` (text lines prefixed `@`) and `serial(0x805, …)`
  (raw binary: framebuffer + palette dumps), rendered server-side to PNG.

## Requirements

- `pico8` on PATH (or `PICO8_BIN=/path/to/pico8`), version 0.2.x
- Node.js ≥ 18
- Carts must use `_update`/`_update60` and read input via `btn`/`btnp`
  (standard carts do; custom `flip()` main loops are not supported)

## Install

```sh
npm install && npm run build
```

opencode config (`opencode.json`):

```json
{
  "mcp": {
    "pico8": {
      "type": "local",
      "command": ["node", "/path/to/pico8-mcp/dist/index.js"]
    }
  }
}
```

Claude Desktop and any other MCP host: same command, stdio transport.

## Tools

| Tool | Purpose |
|---|---|
| `pico8_boot` | Start a cart under lockstep control (game time frozen until you step). Optional `seed` for deterministic `rnd()`. |
| `pico8_step` | Hold buttons (`left/right/up/down/o/x`), advance N frames, get a screenshot. |
| `pico8_play` | Scripted sequence of `{buttons, frames}` steps in one call. |
| `pico8_screen` | Pixel-perfect PNG of the current frame (scale 1–4). |
| `pico8_read` | Read Lua globals by dotted path (`player.x`, `objects.1.type`…). |
| `pico8_peek` | Hex dump of PICO-8 RAM (`0x6000` framebuffer, `0x2000` map…). |
| `pico8_reset` | Kill + restart from the original file (picks up cart edits). |
| `pico8_shutdown` / `pico8_sessions` | Lifecycle / listing. |
| `pico8_boot_check` | Run the unmodified cart with `pico8 -x` for N seconds and report boot errors (benchmark-style check). |

Multiple sessions can run side by side; `session_id` defaults to the most
recent live one.

## Live viewer

The server hosts a small local web page so you can **watch the LLM play in
real time**: open <http://127.0.0.1:7864/> in a browser. It shows the game
screen (streamed over SSE), the buttons currently held, and a log of every
tool call plus the cart's `printh` output.

- While a browser tab is connected, batched steps are split into small chunks
  (default 15 frames) with a screen grab after each, so long `pico8_step`
  calls play back like a fast-forward video. With no viewer connected there
  is zero overhead.
- Playback runs at the LLM's pace (usually much faster than real time).

Env knobs:

| Variable | Default | Effect |
|---|---|---|
| `PICO8_MCP_VIEWER` | `1` | set to `0` to disable the viewer entirely |
| `PICO8_MCP_VIEWER_PORT` | `7864` | listen port (binds 127.0.0.1 only) |
| `PICO8_MCP_VIEWER_CHUNK` | `15` | frames per intermediate screen grab while spectating |

If the port is already in use (e.g. a second MCP host), the viewer is
disabled with a warning on stderr and the server keeps working normally.

## Semantics worth knowing

- Buttons stay **held** between steps; `btnp()` fires on the first frame of a
  new press only. To tap twice: step with the button, step with `buttons: []`,
  step with the button again.
- Screenshots are taken **post-`_draw`** of the last stepped frame.
- A runtime error in the cart kills the `-x` process; the error text is
  surfaced in the tool result. `pico8_reset` starts over.
- The harness uses GPIO memory (`0x5f80–0x5fff`) as its packet buffer and
  overrides `btn`/`btnp` globals — carts that use GPIO themselves or cache
  `local btn=btn` before the harness loads will misbehave.

## Development

- `npm run build` then `node test/mcp-probe.mjs [cart.p8]` runs an end-to-end
  probe through a real MCP client (boot → play → read → shutdown).
- `PICO8_BIN` selects an alternative PICO-8 binary.
