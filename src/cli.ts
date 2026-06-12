#!/usr/bin/env node
import { runMcp } from "./index.js";
import { startDashboard } from "./dashboard/server.js";
import { dashboardPort } from "./config.js";

const fail = (err: unknown): void => {
  process.stderr.write((err instanceof Error ? (err.stack ?? err.message) : String(err)) + "\n");
  process.exit(1);
};

function main(): void {
  const cmd = process.argv[2];

  if (cmd === "dashboard") {
    // Optional explicit port: `earthdeck dashboard 5005`
    const portArg = process.argv[3];
    const port = portArg ? Number.parseInt(portArg, 10) : dashboardPort();
    startDashboard(Number.isFinite(port) ? port : dashboardPort());
    return;
  }

  if (cmd === "demo") {
    // Lazy import so the plain MCP path stays lean.
    void import("./demo.js").then((m) => m.runDemo()).catch(fail);
    return;
  }

  if (cmd === "doctor") {
    void import("./doctor.js").then((m) => m.runDoctor()).catch(fail);
    return;
  }

  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(
      [
        "earthdeck — the Earth-system data layer: MCP server + live dashboard",
        "",
        "Usage:",
        "  earthdeck              start the MCP server on stdio (for Claude Code/Desktop)",
        "  earthdeck demo         ★ zero-key demo: dashboard + live planet data, one command",
        "  earthdeck doctor       check your setup (env keys + data-source reachability)",
        "  earthdeck dashboard    start the dashboard server (default :5005)",
        "  earthdeck dashboard <port>",
        "",
        "Env (all optional): CDSE_CLIENT_ID, CDSE_CLIENT_SECRET, FIRMS_MAP_KEY,",
        "                    EARTHDECK_DASHBOARD_URL, EARTHDECK_DASHBOARD_PORT, EARTHDECK_STAC_URL",
        "",
      ].join("\n"),
    );
    return;
  }

  void runMcp().catch(fail);
}

main();
