#!/usr/bin/env node
// Live smoke-driver: boots the dashboard + MCP server (stdio) and exercises tools
// against the real APIs. Usage: node scripts/live-drive.mjs [tool ...]
// Reads creds from .env. Not part of the test suite — manual verification only.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const PORT = 5099;
const env = { ...process.env };
try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
} catch {}
env.EARTHDECK_DASHBOARD_URL = `http://127.0.0.1:${PORT}`;
env.EARTHDECK_DASHBOARD_PORT = String(PORT);

const dash = spawn("node", ["dist/cli.js", "dashboard"], { env, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));

const transport = new StdioClientTransport({ command: "node", args: ["dist/cli.js"], env });
const client = new Client({ name: "live-drive", version: "0.0.0" });
await client.connect(transport);

const MANAUS = [-60.2, -3.3, -59.8, -2.9];
const only = process.argv.slice(2);

const calls = [
  ["stac_search", { bbox: MANAUS, dateFrom: "2026-05-01", dateTo: "2026-06-10", maxCloud: 60, limit: 5 }],
  ["eo_index", { bbox: MANAUS, index: "NDVI", dateTo: "2026-06-10" }],
  ["sar_render", { bbox: MANAUS, date: "2026-06-10", view: "falseColor", width: 512 }],
  ["sar_water", { bbox: MANAUS, date: "2026-06-10" }],
  ["sar_flood", { bbox: MANAUS, dateBefore: "2026-04-15", dateAfter: "2026-06-10" }],
  // ---- Earth Pulse: planetary indicators (all zero-key) ----
  ["enso", { months: 60 }],
  ["ocean_temp", { lat: 0, lon: -145, start: "2015-01-01" }], // Niño3.4 center, 11y
  ["co2", {}],
  ["global_temp", {}],
  ["sea_ice", { pole: "north" }],
  ["sea_ice", { pole: "south" }],
  ["quakes", { minMagnitude: 5.5, days: 7 }],
  ["climate_history", { lat: 52.52, lon: 13.41, startYear: 1950 }], // Berlin, 76y
  ["air_quality", { lat: 28.6, lon: 77.2 }], // Delhi
  ["river_discharge", { lat: -3.1, lon: -60.0 }], // Rio Negro at Manaus
  ["planet_pulse", {}],
  ["earthdata_search", { keyword: "soil moisture", bbox: MANAUS, limit: 5 }],
];

const { tools } = await client.listTools();
console.log(`TOOLS (${tools.length}): ${tools.map((t) => t.name).join(", ")}\n`);

let failed = 0;
for (const [name, args] of calls) {
  if (only.length && !only.includes(name)) continue;
  const t0 = Date.now();
  try {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    const text = res.content.find((c) => c.type === "text")?.text ?? "";
    const img = res.content.find((c) => c.type === "image");
    const head = text.length > 700 ? text.slice(0, 700) + " …" : text;
    const flag = res.isError ? "✗ ERROR" : "✓";
    if (res.isError) failed++;
    console.log(`${flag} ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)${img ? ` [image ${img.data.length}b64]` : ""}\n${head}\n`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name} threw: ${e.message}\n`);
  }
}

const state = await fetch(`http://127.0.0.1:${PORT}/api/state`).then((r) => r.json());
console.log(`DASHBOARD: ${state.cards.length} card(s): ${state.cards.map((c) => `${c.type}:"${c.title}"`).join(" | ")}`);

await client.close();
dash.kill();
process.exit(failed ? 1 : 0);
