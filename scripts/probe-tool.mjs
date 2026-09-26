// Dev helper: call one MCP tool in-process and print its text result.
//   node --env-file=.env scripts/probe-tool.mjs <tool> '<json args>'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/index.js";

const [tool, argsJson = "{}"] = process.argv.slice(2);
if (!tool) {
  console.error("usage: node --env-file=.env scripts/probe-tool.mjs <tool> '<json args>'");
  process.exit(2);
}
const server = buildServer();
const [st, ct] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "earthdeck-probe", version: "1.0.0" });
await Promise.all([server.connect(st), client.connect(ct)]);
const res = await client.callTool({ name: tool, arguments: JSON.parse(argsJson) }, undefined, { timeout: 180_000 });
const text = res.content
  .filter((c) => c.type === "text")
  .map((c) => c.text)
  .join("\n");
console.log(`isError: ${Boolean(res.isError)}`);
console.log(text);
await client.close();
await server.close();
