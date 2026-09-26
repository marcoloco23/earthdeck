// The kernel's memory between sweeps, next to the ledger: what was called, what was
// found, where each AOI×rule's watermark stands, and a heartbeat an external watchdog can
// read. Plain files — no database until v2 (Temporal/SQLite), per the architecture ladder.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface JournalRecord {
  t: string;
  sweepId: string;
  kind: "sweep_start" | "tool_call" | "candidate" | "created" | "evidence_added" | "confirmed" | "expired" | "gap" | "skip" | "sweep_end" | "budget_exhausted" | `analyst_${string}`;
  aoi?: string;
  rule?: string;
  tool?: string;
  args?: unknown;
  ms?: number;
  responseSha256?: string;
  findingId?: string;
  message?: string;
  [k: string]: unknown;
}

export class Journal {
  private watermarks: Record<string, string> = {};
  private keys: Record<string, string> = {};

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.watermarks = readJson(join(dir, "watermarks.json"), {});
    this.keys = readJson(join(dir, "keys.json"), {});
  }

  append(rec: JournalRecord): void {
    appendFileSync(join(this.dir, "journal.jsonl"), `${JSON.stringify(rec)}\n`);
  }

  watermark(aoiId: string, rule: string): string | null {
    return this.watermarks[`${aoiId}:${rule}`] ?? null;
  }

  setWatermark(aoiId: string, rule: string, at: string): void {
    this.watermarks[`${aoiId}:${rule}`] = at;
    writeFileSync(join(this.dir, "watermarks.json"), JSON.stringify(this.watermarks, null, 2));
  }

  /** Stable key for "this rule on this AOI" — maps to the latest finding opened for it. */
  static findingKey(rule: string, version: string, aoiId: string): string {
    return createHash("sha256").update(`${rule}@${version}\n${aoiId}`).digest("hex").slice(0, 32);
  }

  findingFor(key: string): string | undefined {
    return this.keys[key];
  }

  setFinding(key: string, findingId: string): void {
    this.keys[key] = findingId;
    writeFileSync(join(this.dir, "keys.json"), JSON.stringify(this.keys, null, 2));
  }

  heartbeat(sweepId: string, at: string, summary: Record<string, unknown>): void {
    writeFileSync(join(this.dir, "heartbeat.json"), JSON.stringify({ sweepId, at, ...summary }, null, 2));
  }

  static hash(v: unknown): string {
    return createHash("sha256").update(JSON.stringify(v) ?? "").digest("hex");
  }
}

export interface Heartbeat {
  sweepId: string;
  at: string;
  [k: string]: unknown;
}

/** The last sweep's heartbeat in a journal dir, or null — read-only (never creates the dir). */
export function readHeartbeat(dir: string): Heartbeat | null {
  const hb = readJson<Partial<Heartbeat> | null>(join(dir, "heartbeat.json"), null);
  return hb && typeof hb.at === "string" && typeof hb.sweepId === "string" ? (hb as Heartbeat) : null;
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}
