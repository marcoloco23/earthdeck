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

  if (cmd === "watch" && process.argv[3] === "export") {
    void import("./watch/export.js").then((m) => m.runExportCli(process.argv.slice(4))).catch(fail);
    return;
  }

  if (cmd === "watch") {
    void import("./watch/run.js").then((m) => m.runWatch(process.argv.slice(3))).catch(fail);
    return;
  }

  if (cmd === "analyst") {
    void import("./analyst/cli.js").then((m) => m.runAnalystCli(process.argv.slice(3))).catch(fail);
    return;
  }

  if (cmd === "ledger") {
    void import("./ledger/cli.js").then((m) => m.runLedgerCli(process.argv.slice(3))).catch(fail);
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
        "  earthdeck watch --once    sweep the watchlists once, write findings to the ledger",
        "  earthdeck watch --once --dry-run [--watchlist <file|dir>] [--max N] [--rules a,b]",
        "  earthdeck watch --once [--shard i/n] [--time-budget SEC]  one shard, stop before the budget",
        "  earthdeck analyst --once  narrate + review (two models) + publish confirmed findings",
        "  earthdeck analyst --once --dry-run [--max N] [--model-narrator id] [--model-reviewer id]",
        "  earthdeck watch export --out <dir> [--base-url URL]  write the public static site",
        "  earthdeck ledger verify   re-derive the findings ledger and check its checkpoint",
        "  earthdeck ledger show [id] list findings (or one finding with its events)",
        "  earthdeck ledger seed     write demo findings into an EMPTY ledger (for the Watch tab)",
        "",
        "Env (all optional): CDSE_CLIENT_ID, CDSE_CLIENT_SECRET, FIRMS_MAP_KEY,",
        "                    EARTHDECK_DASHBOARD_URL, EARTHDECK_DASHBOARD_PORT, EARTHDECK_STAC_URL,",
        "                    EARTHDECK_LEDGER_DIR (data/ledger), EARTHDECK_LEDGER_KEY (base64 Ed25519 seed),",
        "                    ANTHROPIC_API_KEY (earthdeck analyst)",
        "",
      ].join("\n"),
    );
    return;
  }

  void runMcp().catch(fail);
}

main();
