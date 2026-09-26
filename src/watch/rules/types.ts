// A rule is the deterministic layer's definition of "what counts". It names its primary
// detector, the *independent* signal that confirms it, the neighbourhood it baselines
// against, and — required — what it cannot see. No LLM is involved in any of this.

import type { Evidence, Geometry } from "../../ledger/schema.js";
import type { BBox } from "../../types.js";
import type { WatchAoi } from "../watchlist.js";

/** Calls an earthdeck tool by name and returns its parsed JSON result. Throws ToolError. */
export type ToolCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export class ToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
    /** Upstream HTTP status / body when the tool reported one (quota detection). */
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(`${tool}: ${message}`);
    this.name = "ToolError";
  }
}

export interface RuleContext {
  aoi: WatchAoi;
  params: Record<string, unknown>;
  /** RFC 3339 "now" of the sweep — injected so runs are reproducible. */
  now: string;
  /** Last time this AOI×rule was swept successfully, or null. */
  since: string | null;
  call: ToolCall;
}

export interface Candidate {
  title: string;
  summary: string;
  observedAt: string;
  evidence: Evidence[];
  /** Headline numbers the narration verifier can check against. */
  values: Record<string, number>;
  geometry?: Geometry;
  /** Regional baseline (the "did it move?" question). */
  baseline?: { metric: string; ringKm: number; aoiValue: number; regionalValue: number; ratio: number | null };
  /** Extra context lines the kernel appends to the finding's `context.notes`. */
  notes?: string[];
}

export interface Confirmation {
  signal: Evidence;
  independence: "sensor" | "provider" | "revisit" | "human";
}

export interface Rule {
  name: string;
  version: string;
  tier: 0 | 1 | 2 | 3;
  description: string;
  /** Required. What this rule cannot see, in plain words. */
  blindSpots: string[];
  /** Env keys the rule needs (for doctor / graceful skip). */
  requires: string[];
  /** Default neighbourhood ring for the regional baseline, km. */
  ringKm: number;
  defaults: Record<string, unknown>;
  detect(ctx: RuleContext): Promise<Candidate | null>;
  /** Try to confirm with an independent signal; null = not (yet) confirmable. */
  confirm(ctx: RuleContext, candidate: Pick<Candidate, "observedAt" | "evidence" | "values" | "geometry">): Promise<Confirmation | null>;
}

export function defineRule(rule: Rule): Rule {
  if (rule.blindSpots.length === 0) throw new Error(`rule ${rule.name}: blindSpots[] is required — every rule must say what it cannot see`);
  if (!/^\d+\.\d+$/.test(rule.version)) throw new Error(`rule ${rule.name}: version must be MAJOR.MINOR`);
  return rule;
}

// ---- small geo helpers shared by rules ---------------------------------------------------

/** Pad a bbox by `km` on every side (longitude padding corrected for latitude). */
export function ringBBox(bbox: BBox, km: number): BBox {
  const [w, s, e, n] = bbox;
  const lat = (s + n) / 2;
  const dLat = km / 111;
  const dLon = km / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return [Math.max(-180, w - dLon), Math.max(-90, s - dLat), Math.min(180, e + dLon), Math.min(90, n + dLat)];
}

export function bboxArea(bbox: BBox): number {
  return (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
}

export function bboxPolygon(bbox: BBox): Geometry {
  const [w, s, e, n] = bbox;
  return { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}

export function dayStart(date: string): string {
  return `${date}T00:00:00Z`;
}

export function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
