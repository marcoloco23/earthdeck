// Read-only HTTP view over the findings ledger, mounted by the dashboard server.
//
//   /api/ledger?status=a,b        all findings (local mission control — includes candidates)
//   /api/ledger/:id               one finding + its events + an inclusion proof for its last event
//   /feed.json  /feed.geojson     PUBLIC findings only — what the static site / journalists consume
//   /ledger/checkpoint            the signed note (C2SP tlog-checkpoint)
//   /ledger/pub                   base64 raw Ed25519 public key
//   /ledger/entries.jsonl         the log itself
//   /ledger/tile/…                tlog-tiles hash tiles
//
// The ledger is re-opened whenever entries.jsonl changes on disk, so a sweep or the CLI
// appending in another process shows up without restarting the dashboard. Everything
// under /ledger/ is a static file a third party can mirror and verify offline.

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { Ledger } from "../ledger/store.js";
import { PUBLIC_STATUSES, type Finding, type Status, STATUSES } from "../ledger/schema.js";

export interface ViewResponse {
  status: number;
  type: string;
  body: string | Buffer;
  headers?: Record<string, string>;
}

const json = (status: number, value: unknown): ViewResponse => ({
  status,
  type: "application/json; charset=utf-8",
  body: JSON.stringify(value),
});

export class LedgerView {
  private ledger: Ledger | null = null;
  private stamp = "";

  constructor(readonly dir: string) {}

  /** Current ledger, re-opened if entries.jsonl changed; null when no ledger exists yet. */
  open(): Ledger | null {
    const entries = join(this.dir, "entries.jsonl");
    if (!existsSync(entries)) return null;
    const st = statSync(entries);
    const stamp = `${st.size}:${st.mtimeMs}`;
    if (!this.ledger || stamp !== this.stamp) {
      this.ledger = Ledger.open(this.dir, { createKey: false });
      this.stamp = stamp;
    }
    return this.ledger;
  }

  async handle(rawUrl: string): Promise<ViewResponse> {
    const [path, query = ""] = rawUrl.split("?", 2) as [string, string?];
    const params = new URLSearchParams(query);

    if (path === "/api/ledger") {
      const l = this.open();
      const wanted = params.get("status")?.split(",").filter((s): s is Status => (STATUSES as readonly string[]).includes(s));
      const findings = l ? l.list(wanted?.length ? { status: wanted } : {}) : [];
      return json(200, { size: l?.size ?? 0, root: l?.root().toString("hex") ?? null, findings });
    }
    if (path.startsWith("/api/ledger/")) {
      const id = decodeURIComponent(path.slice("/api/ledger/".length));
      const l = this.open();
      const f = l?.get(id);
      if (!l || !f) return json(404, { error: "no such finding" });
      const events = l.eventsOf(id);
      const index = l.eventIndex(events[events.length - 1]!.eventId) ?? -1;
      return json(200, { finding: f, events, inclusion: index >= 0 ? { index, ...l.inclusionProof(index) } : null });
    }
    if (path === "/feed.json") {
      const l = this.open();
      const items = l ? l.list({ status: [...PUBLIC_STATUSES] }).map(publicView) : [];
      return json(200, { generatedAt: new Date().toISOString(), checkpoint: l?.checkpointText() ?? null, count: items.length, findings: items });
    }
    if (path === "/feed.geojson") {
      const l = this.open();
      const items = l ? l.list({ status: [...PUBLIC_STATUSES] }) : [];
      return {
        status: 200,
        type: "application/geo+json; charset=utf-8",
        body: JSON.stringify({
          type: "FeatureCollection",
          features: items.map((f) => ({ type: "Feature", id: f.findingId, geometry: f.geometry, properties: publicView(f) })),
        }),
      };
    }
    if (path === "/ledger/checkpoint") {
      const l = this.open();
      const cp = l?.checkpointText();
      return cp ? { status: 200, type: "text/plain; charset=utf-8", body: cp, headers: { "cache-control": "no-cache" } } : { status: 404, type: "text/plain", body: "no checkpoint" };
    }
    if (path === "/ledger/pub") {
      const p = join(this.dir, "ledger.pub");
      return existsSync(p) ? { status: 200, type: "text/plain; charset=utf-8", body: await readFile(p) } : { status: 404, type: "text/plain", body: "no public key" };
    }
    if (path === "/ledger/entries.jsonl") {
      const p = join(this.dir, "entries.jsonl");
      return existsSync(p) ? { status: 200, type: "application/jsonl; charset=utf-8", body: await readFile(p) } : { status: 404, type: "text/plain", body: "no entries" };
    }
    if (path.startsWith("/ledger/tile/")) {
      // Tiles are immutable once full; partial tiles change, so short cache.
      const rel = normalize(decodeURIComponent(path.slice("/ledger/".length))).replace(/^(\.\.[/\\])+/, "");
      const abs = join(this.dir, rel);
      if (!abs.startsWith(join(this.dir, "tile")) || !existsSync(abs)) return { status: 404, type: "text/plain", body: "no such tile" };
      const full = !/\.p\/\d+$/.test(rel);
      return { status: 200, type: "application/octet-stream", body: await readFile(abs), headers: { "cache-control": full ? "public, max-age=31536000, immutable" : "no-cache" } };
    }
    return { status: 404, type: "text/plain", body: "not found" };
  }
}

/** The public projection of a finding: everything, minus nothing — publication *is* disclosure. */
function publicView(f: Finding): Record<string, unknown> {
  const { history, lastEventHash, eventCount, ...rest } = f;
  return { ...rest, events: eventCount, lastEventHash, timeline: history.map((h) => ({ at: h.at, kind: h.kind, status: h.status })) };
}
