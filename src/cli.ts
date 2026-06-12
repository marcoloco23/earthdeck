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
    // Optional explicit port: `overview-mcp dashboard 5005`
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
        "overview-mcp — the Earth-system data layer: MCP server + live dashboard",
        "",
        "Usage:",
        "  overview-mcp              start the MCP server on stdio (for Claude Code/Desktop)",
        "  overview-mcp demo         ★ zero-key demo: dashboard + live planet data, one command",
        "  overview-mcp doctor       check your setup (env keys + data-source reachability)",
        "  overview-mcp dashboard    start the dashboard server (default :5005)",
        "  overview-mcp dashboard <port>",
        "",
        "Env (all optional): CDSE_CLIENT_ID, CDSE_CLIENT_SECRET, FIRMS_MAP_KEY,",
        "                    OVERVIEW_DASHBOARD_URL, OVERVIEW_DASHBOARD_PORT",
        "",
      ].join("\n"),
    );
    return;
  }

  void runMcp().catch(fail);
}

main();
