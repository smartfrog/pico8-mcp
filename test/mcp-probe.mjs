// MCP layer probe: connects to the server over stdio like a real client
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CART = process.argv[2] ?? "/home/fred/projects/pico-celeste-bench/results/qwen37.p8";

const client = new Client({ name: "probe", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: [new URL("../dist/index.js", import.meta.url).pathname],
  }),
);

const tools = await client.listTools();
console.log(`tools: ${tools.tools.map((t) => t.name).join(", ")}`);

const show = (r) => {
  for (const c of r.content) {
    if (c.type === "text") console.log(`  text: ${c.text.split("\n").join("\n        ")}`);
    else if (c.type === "image") console.log(`  image: ${c.mimeType}, ${c.data.length} b64 chars`);
  }
  if (r.isError) console.log("  (isError)");
};

console.log("\n== pico8_boot ==");
show(await client.callTool({ name: "pico8_boot", arguments: { cart_path: CART } }));

console.log("\n== pico8_play (walk right, jump, dash) ==");
show(
  await client.callTool({
    name: "pico8_play",
    arguments: {
      steps: [
        { buttons: ["right"], frames: 30 },
        { buttons: ["right", "o"], frames: 3 },
        { buttons: ["right"], frames: 10 },
        { buttons: ["right", "x"], frames: 2 },
        { buttons: [], frames: 30 },
      ],
    },
  }),
);

console.log("\n== pico8_read ==");
show(await client.callTool({ name: "pico8_read", arguments: { globals: ["pl.x", "pl.y", "win", "score"] } }));

console.log("\n== pico8_sessions ==");
show(await client.callTool({ name: "pico8_sessions", arguments: {} }));

console.log("\n== pico8_boot_check (unmodified cart) ==");
show(await client.callTool({ name: "pico8_boot_check", arguments: { cart_path: CART, seconds: 3 } }));

console.log("\n== error case: bad cart path ==");
show(await client.callTool({ name: "pico8_boot", arguments: { cart_path: "/nope/missing.p8" } }));

console.log("\n== pico8_shutdown ==");
show(await client.callTool({ name: "pico8_shutdown", arguments: {} }));

await client.close();
console.log("\n=== MCP PROBE OK ===");
process.exit(0);
