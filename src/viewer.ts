/**
 * Live viewer — a tiny local HTTP server so a human can watch what the LLM
 * is doing: game screen (SSE-streamed PNG frames), held buttons, tool calls
 * and cart console output.
 *
 * Zero dependencies (node:http). Never blocks or kills the MCP server: if the
 * port is busy the viewer is simply disabled with a warning on stderr.
 *
 * Env:
 *   PICO8_MCP_VIEWER=0        disable the viewer
 *   PICO8_MCP_VIEWER_PORT=n   listen port (default 7864)
 */
import { createServer, type ServerResponse } from "node:http";

export type ViewerEvent =
  | { type: "frame"; session: string; frame: number; hz: number; buttons: string[]; png: string }
  | { type: "tool"; name: string; args: unknown; ms: number; isError: boolean }
  | { type: "console"; session: string; lines: string[] }
  | { type: "status"; text: string };

const clients = new Set<ServerResponse>();
let lastFrame: ViewerEvent | null = null;
const history: ViewerEvent[] = []; // recent non-frame events, replayed to late joiners
const HISTORY_MAX = 100;

export function hasClients(): boolean {
  return clients.size > 0;
}

function sse(ev: ViewerEvent): string {
  return `data: ${JSON.stringify(ev)}\n\n`;
}

export function broadcast(ev: ViewerEvent): void {
  if (ev.type === "frame") {
    lastFrame = ev;
  } else {
    history.push(ev);
    if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
  }
  if (clients.size === 0) return;
  const payload = sse(ev);
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

export function startViewer(): string | null {
  if (process.env.PICO8_MCP_VIEWER === "0") return null;
  const port = parseInt(process.env.PICO8_MCP_VIEWER_PORT ?? "7864", 10) || 7864;

  const server = createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
    } else if (req.url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      // replay state so a page opened mid-game shows something immediately
      if (lastFrame) res.write(sse(lastFrame));
      for (const ev of history) res.write(sse(ev));
      clients.add(res);
      req.socket.unref(); // never keep the process alive because of a spectator
      req.on("close", () => clients.delete(res));
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });

  server.on("error", (err) => {
    console.error(`pico8-mcp: viewer disabled (${(err as Error).message})`);
  });
  server.listen(port, "127.0.0.1");
  server.unref();

  // keep SSE connections from being reaped by intermediaries / detect dead ones
  const ping = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(": ping\n\n");
      } catch {
        clients.delete(res);
      }
    }
  }, 25000);
  ping.unref();

  return `http://127.0.0.1:${port}/`;
}

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>pico8-mcp viewer</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #1d2b53; color: #fff1e8; font: 13px/1.5 ui-monospace, monospace; display: flex; height: 100vh; }
  #left { padding: 20px; display: flex; flex-direction: column; align-items: center; gap: 14px; }
  #screen { width: 512px; height: 512px; image-rendering: pixelated; background: #000; border: 2px solid #5f574f; }
  #hud { display: flex; gap: 8px; }
  .btn { min-width: 34px; text-align: center; padding: 4px 8px; border: 1px solid #5f574f; border-radius: 4px; color: #5f574f; }
  .btn.on { background: #ff004d; color: #fff1e8; border-color: #ff004d; }
  #meta { color: #c2c3c7; }
  #right { flex: 1; display: flex; flex-direction: column; background: #10182f; border-left: 2px solid #5f574f; min-width: 0; }
  #right h1 { font-size: 13px; margin: 0; padding: 10px 14px; color: #ffa300; border-bottom: 1px solid #5f574f; }
  #log { flex: 1; overflow-y: auto; padding: 10px 14px; }
  .ev { margin-bottom: 3px; white-space: pre-wrap; word-break: break-all; }
  .ev.tool { color: #29adff; }
  .ev.tool.err { color: #ff004d; }
  .ev.console { color: #ffec27; }
  .ev.status { color: #00e436; }
  .ev .t { color: #5f574f; }
  #conn { color: #5f574f; padding: 6px 14px; border-top: 1px solid #5f574f; }
  #conn.live { color: #00e436; }
</style>
</head>
<body>
  <div id="left">
    <img id="screen" width="512" height="512" alt="pico-8 screen">
    <div id="hud">
      <span class="btn" id="b-left">&#8592;</span>
      <span class="btn" id="b-right">&#8594;</span>
      <span class="btn" id="b-up">&#8593;</span>
      <span class="btn" id="b-down">&#8595;</span>
      <span class="btn" id="b-o">O</span>
      <span class="btn" id="b-x">X</span>
    </div>
    <div id="meta">waiting for a session&hellip;</div>
  </div>
  <div id="right">
    <h1>pico8-mcp &mdash; LLM activity</h1>
    <div id="log"></div>
    <div id="conn">connecting&hellip;</div>
  </div>
<script>
"use strict";
var $ = function (id) { return document.getElementById(id); };
var BUTTONS = ["left", "right", "up", "down", "o", "x"];
var log = $("log");

function addLog(cls, text) {
  var atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  var d = document.createElement("div");
  d.className = "ev " + cls;
  var t = document.createElement("span");
  t.className = "t";
  t.textContent = new Date().toLocaleTimeString() + " ";
  d.appendChild(t);
  d.appendChild(document.createTextNode(text));
  log.appendChild(d);
  while (log.children.length > 500) log.removeChild(log.firstChild);
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function fmtArgs(args) {
  var s;
  try { s = JSON.stringify(args); } catch (e) { s = String(args); }
  if (!s) s = "{}";
  return s.length > 300 ? s.slice(0, 300) + "\\u2026" : s;
}

function handle(ev) {
  if (ev.type === "frame") {
    $("screen").src = "data:image/png;base64," + ev.png;
    $("meta").textContent =
      "session " + ev.session + " \\u2014 frame " + ev.frame +
      " (" + (ev.frame / ev.hz).toFixed(2) + "s @ " + ev.hz + "fps)";
    for (var i = 0; i < BUTTONS.length; i++) {
      var b = BUTTONS[i];
      $("b-" + b).classList.toggle("on", ev.buttons.indexOf(b) >= 0);
    }
  } else if (ev.type === "tool") {
    addLog("tool" + (ev.isError ? " err" : ""),
      ev.name + " " + fmtArgs(ev.args) + " [" + ev.ms + "ms]" + (ev.isError ? " ERROR" : ""));
  } else if (ev.type === "console") {
    for (var j = 0; j < ev.lines.length; j++) addLog("console", "printh> " + ev.lines[j]);
  } else if (ev.type === "status") {
    addLog("status", ev.text);
  }
}

var es = new EventSource("/events");
es.onopen = function () {
  $("conn").textContent = "live";
  $("conn").className = "live";
};
es.onerror = function () {
  $("conn").textContent = "disconnected \\u2014 retrying\\u2026";
  $("conn").className = "";
};
es.onmessage = function (e) { handle(JSON.parse(e.data)); };
</script>
</body>
</html>
`;
