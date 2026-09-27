// The deterministic side of the analyst: what the models are shown (the dossier), what
// their JSON must look like (zod + the JSON schemas sent as structured outputs), and the
// checks that decide whether a narration or review counts — numeric faithfulness, the
// no-persons rule, and the publish gates. The model writes; this file decides.

import { z } from "zod";
import type { Evidence, Finding } from "../ledger/schema.js";

// ---- Output contracts ----------------------------------------------------------------------

export const narrationSchema = z.object({
  headline: z.string().min(1).max(120),
  narrative: z.string().min(1).max(1200),
  keyNumbers: z.array(z.object({ label: z.string().min(1).max(120), value: z.number(), evidenceId: z.string().min(1) })).min(1).max(12),
  confidence: z.enum(["low", "medium", "high"]),
  caveats: z.array(z.string().min(1).max(300)).max(10),
});
export type Narration = z.infer<typeof narrationSchema>;

export const reviewSchema = z.object({
  verdict: z.enum(["publish", "hold", "reject"]),
  reasons: z.array(z.string().min(1).max(500)).min(1).max(10),
  checks: z.object({
    evidenceSupportsClaims: z.boolean(),
    blindSpotsAcknowledged: z.boolean(),
    noIndividualsNamed: z.boolean(),
    controlAoi: z.boolean(),
  }),
});
export type Review = z.infer<typeof reviewSchema>;

// Structured-outputs JSON schemas (no min/max length support there — zod enforces those).
const str = { type: "string" };
export const NARRATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "narrative", "keyNumbers", "confidence", "caveats"],
  properties: {
    headline: str,
    narrative: str,
    keyNumbers: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["label", "value", "evidenceId"], properties: { label: str, value: { type: "number" }, evidenceId: str } },
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    caveats: { type: "array", items: str },
  },
};
export const REVIEW_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "reasons", "checks"],
  properties: {
    verdict: { type: "string", enum: ["publish", "hold", "reject"] },
    reasons: { type: "array", items: str },
    checks: {
      type: "object",
      additionalProperties: false,
      required: ["evidenceSupportsClaims", "blindSpotsAcknowledged", "noIndividualsNamed", "controlAoi"],
      properties: {
        evidenceSupportsClaims: { type: "boolean" },
        blindSpotsAcknowledged: { type: "boolean" },
        noIndividualsNamed: { type: "boolean" },
        controlAoi: { type: "boolean" },
      },
    },
  },
};

// ---- Dossier -------------------------------------------------------------------------------

/** Everything a model may know about a finding — and nothing else. */
// HOOK (deliberately unused): "In the news" headlines (src/watch/news.ts, cached under
// <ledger dir>/news/<id>.json) could be offered to the narrator here as clearly-labelled
// *context* one day. They must never reach the reviewer's checks or count as confirmation —
// GDELT matches by place name and keyword, not by location, and is noisy.
export function dossier(f: Finding) {
  const ev = (e: Evidence) => ({ id: e.id, kind: e.kind, source: e.source, datetime: e.datetime, method: e.method, summary: e.summary, values: e.values, href: e.href });
  return {
    findingId: f.findingId,
    title: f.title,
    summary: f.summary,
    tier: f.tier,
    rule: f.rule,
    aoi: f.aoi ? { ...f.aoi, control: isControl(f) } : undefined,
    observedAt: f.observedAt,
    evidence: f.evidence.map(ev),
    confirmation: f.confirmed ? { independence: f.confirmed.independence, at: f.confirmed.at, signal: ev(f.confirmed.signal) } : null,
    context: f.context ?? null,
    blindSpots: f.blindSpots ?? [],
  };
}

export const isControl = (f: Finding) => Boolean(f.aoi?.tags?.includes("control"));

// ---- Faithfulness --------------------------------------------------------------------------

/** Numbers written in a text ("−0.213", "1,234", "95%"). Loose on purpose: dates yield parts. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.replace(/−/g, "-").matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
/** A narrated number may be a rounding of a known one at the narrated precision (232.05 ha → "232 ha"). */
const rounds = (known: number, narrated: number) => {
  const dec = (String(narrated).split(".")[1] ?? "").length;
  const f = 10 ** dec;
  return same(Math.round(known * f) / f, narrated);
};

/** Numbers in `output` that do not appear (even rounded) in `source`; small counting integers 0–10 excepted. */
export function numbersNotIn(output: string, source: string): number[] {
  const known = numbersIn(source).map(Math.abs);
  return numbersIn(output).filter((v) => {
    const a = Math.abs(v);
    if (Number.isInteger(a) && a <= 10) return false;
    return !known.some((k) => same(k, a) || rounds(k, a));
  });
}

/**
 * Violations (empty = faithful): every key number must appear verbatim in its cited
 * evidence's `values` or `summary`; every other number in the headline/narrative must
 * appear somewhere in the dossier (small counting integers 0–10 excepted); no personal names.
 */
export function faithfulness(f: Finding, n: Narration): string[] {
  const problems: string[] = [];
  const all = [...f.evidence, ...(f.confirmed ? [f.confirmed.signal] : [])];
  for (const k of n.keyNumbers) {
    const e = all.find((x) => x.id === k.evidenceId);
    if (!e) {
      problems.push(`keyNumbers "${k.label}" cites evidence "${k.evidenceId}", which this finding does not hold`);
      continue;
    }
    const pool = [...Object.values(e.values ?? {}), ...numbersIn(e.summary ?? "")];
    if (!pool.some((v) => same(v, k.value))) {
      problems.push(`keyNumbers "${k.label}" = ${k.value} does not appear verbatim in evidence "${k.evidenceId}" (values/summary hold: ${[...new Set(pool)].slice(0, 20).join(", ") || "none"})`);
    }
  }
  const { findingId: _id, ...facts } = dossier(f); // the UUID's digits are not facts
  const text = JSON.stringify(facts);
  for (const v of numbersNotIn(`${n.headline}\n${n.narrative}`, text)) problems.push(`the number ${v} in the headline/narrative does not appear (even rounded) in the finding's evidence or context`);
  for (const name of personalNames(`${n.headline}\n${n.narrative}\n${n.caveats.join("\n")}\n${n.keyNumbers.map((k) => k.label).join("\n")}`, text)) {
    problems.push(`possible personal name "${name}" — never name people; if it is a place or institution, copy it exactly as it appears in the finding`);
  }
  return problems;
}

// ---- No persons ----------------------------------------------------------------------------

const HONORIFIC = /\b(?:Mr|Mrs|Ms|Mx|Dr|Prof|Sr|Sra|Srta|Dona|Dom|Sir|Madam|Senhor|Senhora|Señor|Señora)\.?\s+\p{Lu}[\p{L}'’-]*/gu;
// Runs never cross a line break: "…26 Sep\nValid pixels…" is two sentences, not a name.
const CAP_RUN = /\p{Lu}[\p{L}'’-]*(?:[ \t]+(?:(?:da|de|do|dos|das|di|del|van|von|la|le|bin|al)[ \t]+)?\p{Lu}[\p{L}'’-]*)+/gu;
const LEADING = new Set(["the", "a", "an", "this", "that", "these", "those", "in", "on", "at", "no", "our", "if", "what", "it", "its", "we", "both", "each", "all", "some", "between", "from", "during", "since", "after", "before", "while", "when", "because", "however", "but", "and", "or", "one", "two", "three", "key", "not"]);
/** Words that make a capitalised run a place, instrument, dataset or institution — not a person. */
const NOT_PERSON = new Set(
  (
    "nasa noaa esa usgs gfw glad radd viirs modis firms eonet emit sentinel landsat copernicus global forest watch integrated alerts " +
    "el la niño niña nino nina enso oni earth amazon amazonia cerrado pantanal state states river basin mountains mountain valley park reserve national " +
    "territory territories indigenous land lands province district region regional coast island islands lake sea ocean bay gulf delta plateau " +
    "protected area areas conservation unit municipality county city north south east west northern southern eastern western central " +
    "january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec monday tuesday wednesday thursday friday saturday sunday " +
    "valid pixels alert alerts loss clearing cloud clouds baseline ring window scene scenes hectares ha percent " +
    "ndvi ndwi nbr sar optical radar median composite satellite data api world pulse finding findings evidence confidence ministry agency institute " +
    "department government company corporation university service program programme united nations brazil peru bolivia colombia indonesia congo"
  ).split(" "),
);

/** Capitalised runs of ≥ 2 words that look like a person's name and are not in the dossier. */
export function personalNames(output: string, dossierText: string): string[] {
  const hay = dossierText.toLowerCase();
  const found = new Set<string>();
  for (const m of output.matchAll(HONORIFIC)) found.add(m[0]);
  for (const m of output.matchAll(CAP_RUN)) {
    const words = m[0].split(/\s+/);
    while (words.length && LEADING.has(words[0]!.toLowerCase())) words.shift();
    const caps = words.filter((w) => /^\p{Lu}/u.test(w));
    if (caps.length < 2) continue;
    if (caps.some((w) => w === w.toUpperCase())) continue; // acronyms: NDVI, VIIRS, GFW…
    if (caps.some((w) => NOT_PERSON.has(w.toLowerCase().replace(/['’]s$/, "")))) continue;
    const phrase = words.join(" ");
    if (hay.includes(phrase.toLowerCase())) continue;
    if (caps.every((w) => hay.includes(w.toLowerCase()))) continue;
    found.add(phrase);
  }
  return [...found];
}

// ---- Publish gates (local mirror of the incoming schema.publishGates) ---------------------

export interface Gates {
  narratedBy: string;
  reviewedBy: string[];
}

type AnyReview = Finding["reviews"][number] & { verdict?: string };

/**
 * Autonomous `confirmed → published` needs: a confirmed finding of tier ≤ 2, a narration by
 * a model, and a later review by a *different* model with verdict `publish` (and no later
 * review that holds or rejects). Mirrors the sibling contract change in schema.ts; swap for
 * `publishGates` from there once it lands.
 */
export function canPublish(f: Finding): { ok: true; gates: Gates } | { ok: false; reason: string } {
  if (f.status !== "confirmed" || !f.confirmed) return { ok: false, reason: `status is ${f.status}, not confirmed` };
  if (f.tier > 2) return { ok: false, reason: `tier ${f.tier} > 2 needs humans (right-of-reply clock)` };
  if (isControl(f)) return { ok: false, reason: "control AOI" };
  const n = f.narration;
  if (!n) return { ok: false, reason: "no narration" };
  if (!n.actor.startsWith("model:")) return { ok: false, reason: "narration is not by a model" };
  const after = (f.reviews as AnyReview[]).filter((r) => r.at >= n.at && r.actor.startsWith("model:"));
  const latest = after[after.length - 1];
  if (!latest) return { ok: false, reason: "no model review after the narration" };
  if (latest.verdict !== "publish") return { ok: false, reason: `latest review verdict is ${latest.verdict ?? "missing"}` };
  if (latest.actor === n.actor) return { ok: false, reason: "reviewer must be a different model than the narrator" };
  if (latest.tier < f.tier) return { ok: false, reason: `review tier ${latest.tier} < finding tier ${f.tier}` };
  return { ok: true, gates: { narratedBy: n.actor, reviewedBy: [latest.actor] } };
}
