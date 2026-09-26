// Dev helper: list the MCP tools the built server registers (name count + names).
//   node scripts/list-tools.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../dist/index.js";

const server = buildServer();
const [st, ct] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "earthdeck-list", version: "1.0.0" });
await Promise.all([server.connect(st), client.connect(ct)]);
const { tools } = await client.listTools();
console.log(`${tools.length} tools: ${tools.map((t) => t.name).sort().join(", ")}`);
await client.close();
await server.close();
