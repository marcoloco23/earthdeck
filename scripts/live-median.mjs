#!/usr/bin/env node
// Live verification for temporal-median compositing: median vs leastCC over Manaus.
// Usage: node scripts/live-median.mjs   (reads .env; manual verification only)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, writeFileSync } from "node:fs";

const env = { ...process.env };
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}

const transport = new StdioClientTransport({ command: "node", args: ["dist/cli.js"], env });
const client = new Client({ name: "live-median", version: "0.0.0" });
await client.connect(transport);

const MANAUS = [-60.2, -3.3, -59.8, -2.9];
const calls = [
  ["eo_index", { bbox: MANAUS, index: "NDVI", date: "2026-06-10", composite: "leastCC" }],
  ["eo_index", { bbox: MANAUS, index: "NDVI", date: "2026-06-10", composite: "median", windowDays: 45 }],
  ["eo_render", { bbox: MANAUS, date: "2026-06-10", view: "trueColor", composite: "leastCC", width: 512 }],
  ["eo_render", { bbox: MANAUS, date: "2026-06-10", view: "trueColor", composite: "median", width: 512 }],
  ["eo_compare", { bbox: [-52.2, -6.75, -51.8, -6.45], dateA: "2019-08-01", dateB: "2025-08-01", composite: "median", width: 512 }],
];

let failed = 0;
let n = 0;
for (const [name, args] of calls) {
  const t0 = Date.now();
  try {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
    const text = res.content.find((c) => c.type === "text")?.text ?? "";
    const imgs = res.content.filter((c) => c.type === "image");
    imgs.forEach((img, i) => {
      const f = `/tmp/median-${n}-${i}-${args.composite}.png`;
      writeFileSync(f, Buffer.from(img.data, "base64"));
      console.log(`  saved ${f}`);
    });
    const flag = res.isError ? "✗ ERROR" : "✓";
    if (res.isError) failed++;
    console.log(`${flag} ${name} composite=${args.composite} (${((Date.now() - t0) / 1000).toFixed(1)}s)\n${text.slice(0, 1400)}\n`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name} threw: ${e.message}\n`);
  }
  n++;
}
await client.close();
process.exit(failed ? 1 : 0);
