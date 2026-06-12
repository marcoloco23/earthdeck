// `overview-mcp demo` — the zero-setup wow path. Starts the dashboard, runs the real MCP
// server in-process (in-memory transport, no stdio), and calls the zero-key tools so the
// map lights up with live planet data. No keys, no config, one command.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { spawn } from "node:child_process";
import { dashboardPort } from "./config.js";
import { startDashboard } from "./dashboard/server.js";
import { buildServer } from "./index.js";

/** Best-effort `open <url>` per platform; failure just means the user clicks the link. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).on("error", () => {});
  } catch {
    /* printing the URL is enough */
  }
}

const out = (s: string) => process.stdout.write(s + "\n");

export async function runDemo(): Promise<void> {
  const port = dashboardPort();
  const url = `http://127.0.0.1:${port}`;
  process.env.OVERVIEW_DASHBOARD_URL = url; // tools push to the dashboard we just started

  out("");
  out("  overview-mcp demo — live Earth data, zero keys");
  out("");
  startDashboard(port);
  openBrowser(url);
  out(`  Dashboard: ${url}  (keep this terminal open)`);
  out("");

  const server = buildServer();
  const [serverT, clientT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "overview-demo", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  // Zero-key calls only, ordered so the most striking cards land last (feed shows newest first).
  const calls: Array<[string, Record<string, unknown>, string]> = [
    ["events", { limit: 50 }, "live natural-disaster events (NASA EONET)"],
    ["quakes", { minMagnitude: 5, days: 7 }, "earthquakes M5+ last 7 days (USGS)"],
    ["co2", {}, "atmospheric CO₂ — the Keeling curve (NOAA)"],
    ["global_temp", {}, "global temperature record since 1880 (NASA)"],
    ["sea_ice", { pole: "north" }, "Arctic sea ice vs climatology (NSIDC)"],
    ["enso", {}, "El Niño / La Niña state (NOAA ONI)"],
    ["planet_pulse", {}, "the planet's vital signs, one call"],
  ];

  for (const [name, args, blurb] of calls) {
    try {
      const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
      out(`  ${res.isError ? "✗" : "✓"} ${name.padEnd(13)} ${blurb}`);
    } catch (err) {
      out(`  ✗ ${name.padEnd(13)} ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  out("");
  out("  That's the planet right now — charts, quakes, and vital signs on the map.");
  out("  Next steps:");
  out("    • Use it from Claude:  claude mcp add overview -- npx -y github:marcoloco23/overview-mcp");
  out("    • Check your setup:    npx -y github:marcoloco23/overview-mcp doctor");
  out("    • Free keys for satellite imagery + fires: see README → 'Free keys'");
  out("");
  out("  Ctrl+C to stop.");
}
