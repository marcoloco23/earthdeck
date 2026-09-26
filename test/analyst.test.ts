// `earthdeck analyst` offline: the Messages API is a fetch mock serving response fixtures
// (hand-built from the documented shape — test/fixtures/anthropic-*.json). The ledger is an
// in-memory fold that enforces the incoming publish policy (model narrator + different
// model reviewer with verdict publish, tier ≤ 2), plus one run against the real Ledger for
// what the current contract already accepts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAnalyst, select, type AnalystLedger } from "../src/analyst/analyst.js";
import { callJson, costUsd } from "../src/analyst/anthropic.js";
import { canPublish, faithfulness, personalNames, type Narration } from "../src/analyst/checks.js";
import { OverviewError } from "../src/errors.js";
import { applyEvent, type Finding, type FindingEvent, type Status } from "../src/ledger/schema.js";
import { Ledger } from "../src/ledger/store.js";
import { uuidv7 } from "../src/util.js";
import { Journal } from "../src/watch/journal.js";
import { jsonResponse, mockFetch, type CapturedCall } from "./helpers.js";

const NARRATION_FIXTURE = JSON.parse(readFileSync("test/fixtures/anthropic-narration.json", "utf8")) as { content: { type: string; text?: string }[]; model: string };
const REVIEW_FIXTURE = JSON.parse(readFileSync("test/fixtures/anthropic-review.json", "utf8")) as typeof NARRATION_FIXTURE;
const GOOD_NARRATION = JSON.parse(NARRATION_FIXTURE.content[1]!.text!) as Narration;
const GFW = "gfw-integrated-br-sfx-2026-06-28..2026-09-26";
const S2 = "s2-ndvi-median-br-sfx-2026-05-14..2026-09-26";

/** A fixture response with its JSON text swapped (and optionally its model). */
function withText(fx: typeof NARRATION_FIXTURE, obj: unknown, model?: string) {
  return { ...fx, model: model ?? fx.model, content: [fx.content[0]!, { type: "text", text: JSON.stringify(obj) }] };
}
const review = (verdict: string, checks: Partial<Record<string, boolean>> = {}) =>
  withText(REVIEW_FIXTURE, { verdict, reasons: [`reviewer says ${verdict}`], checks: { evidenceSupportsClaims: true, blindSpotsAcknowledged: true, noIndividualsNamed: true, controlAoi: false, ...checks } });

function createdInput(o: { tier?: number; control?: boolean } = {}) {
  return {
    kind: "created" as const,
    actor: "system:forest_loss@1.0",
    rule: { name: "forest_loss", version: "1.0", params: { days: 90, minAlerts: 100, minHa: 10 } },
    title: "Forest loss, São Félix do Xingu: 38.2 ha in 90 d",
    summary: "420 GFW integrated deforestation alerts (≥ high confidence) covering 38.2 ha between 2026-06-28 and 2026-09-26; AOI alert density is 1.47× its 25 km neighbourhood.",
    tier: o.tier ?? 1,
    geometry: { type: "Point" as const, coordinates: [-52.15, -6.65] as [number, number] },
    bbox: [-52.4, -6.9, -51.9, -6.4] as [number, number, number, number],
    aoi: { id: "br-sfx", name: "São Félix do Xingu", tags: o.control ? ["amazon", "control"] : ["amazon"] },
    observedAt: "2026-09-26T00:00:00Z",
    evidence: [
      {
        id: GFW,
        kind: "alert" as const,
        source: "gfw-integrated-alerts",
        datetime: "2026-09-26T00:00:00Z",
        method: { name: "forest_alerts", version: "1.0" },
        summary: "420 alerts (≥ high confidence), 38.2 ha, 2026-06-28…2026-09-26.",
        values: { alerts: 420, ha: 38.2, high_alerts: 420, high_ha: 38.2 },
      },
    ],
    context: {
      enso: { phase: "La Niña", oni: -0.7 },
      events: [{ id: "EONET_1", title: "Drought, Pará", category: "Drought" }],
      baseline: { metric: "alert ha per deg²", ringKm: 25, aoiValue: 152.8, regionalValue: 103.9, ratio: 1.47 },
    },
    blindSpots: ["Cannot distinguish legal clearing, fire, storm damage and selective logging from illegal clearing.", "Alerts lag reality by ~1–2 weeks."],
    at: "2026-09-26T12:00:00Z",
  };
}
const confirmedInput = (findingId: string) => ({
  kind: "confirmed" as const,
  findingId,
  actor: "system:forest_loss@1.0",
  independence: "sensor" as const,
  signal: {
    id: S2,
    kind: "scene" as const,
    source: "sentinel-2-l2a",
    datetime: "2026-09-26T00:00:00Z",
    method: { name: "eo_compare", version: "1.0" },
    summary: "Median-composite NDVI changed -0.210 (2026-05-14 → 2026-09-26); valid pixels 95% / 95%.",
    values: { deltaNdvi: -0.21, validPctA: 95, validPctB: 95 },
  },
  at: "2026-09-26T12:00:01Z",
});

/**
 * In-memory ledger folding with the real `applyEvent`, enforcing the *incoming* publish
 * policy on `→ published` (the sibling schema change) instead of today's human-only rule.
 */
class PolicyLedger {
  findings = new Map<string, Finding>();
  events: FindingEvent[] = [];
  seed(o: { tier?: number; control?: boolean } = {}): string {
    const findingId = uuidv7();
    this.append({ ...createdInput(o), findingId });
    this.append(confirmedInput(findingId));
    this.events = [];
    return findingId;
  }
  list(filter: { status?: Status[] } = {}): Finding[] {
    return [...this.findings.values()].filter((f) => !filter.status || filter.status.includes(f.status));
  }
  get(id: string): Finding | undefined {
    return this.findings.get(id);
  }
  append(input: Record<string, unknown>) {
    const cur = this.findings.get(input.findingId as string) ?? null;
    const ev = { v: 1, eventId: uuidv7(), at: new Date().toISOString(), prev: cur?.lastEventHash ?? null, ...input } as unknown as FindingEvent;
    if (ev.kind === "status_changed") {
      assert.equal(ev.from, cur!.status);
      if (ev.to === "published") {
        const g = canPublish(cur!);
        if (!g.ok) throw new Error(`publish gate: ${g.reason}`);
        assert.ok((input as { gates?: unknown }).gates, "publish carries gates");
      }
    }
    this.findings.set(ev.findingId, applyEvent(cur, ev));
    this.events.push(ev);
    return { event: ev, index: this.events.length - 1 };
  }
}

/** Anthropic calls answered from per-model queues; the dashboard push is swallowed. */
function anthropicMock(queues: Record<string, unknown[]>) {
  const api: CapturedCall[] = [];
  const fm = mockFetch((url, call) => {
    if (!url.startsWith("https://api.anthropic.com/")) return new Response("{}", { status: 200 });
    api.push(call);
    const model = (JSON.parse(call.body!) as { model: string }).model;
    const next = queues[model]?.shift();
    if (!next) return jsonResponse({ type: "error", error: { type: "invalid_request_error", message: `unexpected call for ${model}` } }, { status: 400 });
    return jsonResponse(next);
  });
  return { api, restore: fm.restore };
}

const journal = () => new Journal(mkdtempSync(join(tmpdir(), "earthdeck-analyst-")));
const journalKinds = (j: Journal) => readFileSync(join(j.dir, "journal.jsonl"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { kind: string }).kind);

test("analyst: happy path — narrate (Opus), review (Sonnet), publish with gates", async (t) => {
  const l = new PolicyLedger();
  const id = l.seed();
  const m = anthropicMock({ "claude-opus-5": [NARRATION_FIXTURE], "claude-sonnet-5": [REVIEW_FIXTURE] });
  t.after(m.restore);
  const j = journal();
  const r = await runAnalyst({ ledger: l as unknown as AnalystLedger, journal: j, apiKey: "sk-test" });

  assert.deepEqual(r.published, [id]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.calls, 2);
  // cost from the fixtures' usage: Opus 3120/2480 @ $5/$25 + Sonnet 3650/1410 @ $2/$10
  assert.ok(Math.abs(r.costUsd - (0.0156 + 0.062 + 0.0073 + 0.0141)) < 1e-9);
  assert.deepEqual(l.events.map((e) => e.kind), ["narrated", "reviewed", "status_changed"]);
  const [narrated, reviewed, published] = l.events as Record<string, unknown>[];
  assert.equal(narrated!.actor, "model:claude-opus-5");
  assert.deepEqual(narrated!.evidenceRefs, [GFW, S2]);
  assert.match(narrated!.text as string, /^Forest loss in São Félix do Xingu.*\n\n.*\n\nKey numbers:\n- Alert area \(ha\): 38\.2 \[gfw-/s);
  assert.match(narrated!.promptSha256 as string, /^[0-9a-f]{64}$/);
  assert.equal(reviewed!.actor, "model:claude-sonnet-5");
  assert.equal(reviewed!.verdict, "publish");
  assert.equal(reviewed!.tier, 1);
  assert.equal(published!.to, "published");
  assert.deepEqual(published!.gates, { narratedBy: "model:claude-opus-5", reviewedBy: ["model:claude-sonnet-5"], policy: "earthdeck-publish/1" });
  assert.equal(l.get(id)!.status, "published");

  // Request shape: key header, version, structured outputs, refusal fallback only on Opus.
  const [nReq, rReq] = m.api;
  assert.equal(nReq!.headers["x-api-key"], "sk-test");
  assert.equal(nReq!.headers["anthropic-version"], "2023-06-01");
  assert.equal(nReq!.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  assert.equal(rReq!.headers["anthropic-beta"], undefined);
  const nBody = JSON.parse(nReq!.body!) as { output_config: { format: { type: string } }; fallbacks?: string; messages: { content: string }[] };
  assert.equal(nBody.output_config.format.type, "json_schema");
  assert.equal(nBody.fallbacks, "default");
  assert.match(nBody.messages[0]!.content, /"control": false/);
  assert.match(nBody.messages[0]!.content, /"ratio": 1\.47/);
  assert.match((JSON.parse(rReq!.body!) as { messages: { content: string }[] }).messages[0]!.content, /Narration to review \(by model:claude-opus-5\)/);

  assert.deepEqual(journalKinds(j), ["analyst_start", "analyst_call", "analyst_append", "analyst_call", "analyst_append", "analyst_end"]);
  // Nothing left to do on a second run.
  assert.equal(select(l as unknown as AnalystLedger, 5).length, 0);
});

test("analyst: faithfulness rejection → one retry quoting the violation → accepted", async (t) => {
  const l = new PolicyLedger();
  const id = l.seed();
  const rounded = { ...GOOD_NARRATION, keyNumbers: [{ label: "Alert area (ha)", value: 38, evidenceId: GFW }] };
  const m = anthropicMock({ "claude-opus-5": [withText(NARRATION_FIXTURE, rounded), NARRATION_FIXTURE], "claude-sonnet-5": [REVIEW_FIXTURE] });
  t.after(m.restore);
  const j = journal();
  const r = await runAnalyst({ ledger: l as unknown as AnalystLedger, journal: j, apiKey: "sk-test" });
  assert.deepEqual(r.published, [id]);
  assert.equal(r.calls, 3);
  const retry = (JSON.parse(m.api[1]!.body!) as { messages: { content: string }[] }).messages[0]!.content;
  assert.match(retry, /rejected by the deterministic checks/);
  assert.match(retry, /"Alert area \(ha\)" = 38 does not appear verbatim in evidence "gfw-/);
  assert.ok(journalKinds(j).includes("analyst_narration_rejected"));
});

test("analyst: a narration that stays unfaithful (or names a person) is never appended", async (t) => {
  const l = new PolicyLedger();
  l.seed();
  const named = { ...GOOD_NARRATION, narrative: `${GOOD_NARRATION.narrative} Local rancher Joaquim Pereira denies it.` };
  const m = anthropicMock({ "claude-opus-5": [withText(NARRATION_FIXTURE, named), withText(NARRATION_FIXTURE, named)] });
  t.after(m.restore);
  const r = await runAnalyst({ ledger: l as unknown as AnalystLedger, journal: journal(), apiKey: "sk-test" });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!.message, /narration rejected after retry: possible personal name "Joaquim Pereira"/);
  assert.equal(l.events.length, 0);
  assert.equal(r.calls, 2, "no review call for a rejected narration");
});

test("analyst: reviewer hold leaves the finding confirmed", async (t) => {
  const l = new PolicyLedger();
  const id = l.seed();
  const m = anthropicMock({ "claude-opus-5": [NARRATION_FIXTURE], "claude-sonnet-5": [review("hold")] });
  t.after(m.restore);
  const r = await runAnalyst({ ledger: l as unknown as AnalystLedger, journal: journal(), apiKey: "sk-test" });
  assert.deepEqual(r.held, [id]);
  assert.deepEqual(l.events.map((e) => e.kind), ["narrated", "reviewed"]);
  assert.equal(l.get(id)!.status, "confirmed");
  assert.equal(select(l as unknown as AnalystLedger, 5).length, 0, "held findings wait for a human, not the next run");
});

test("analyst: reviewer flags an individual → forced hold even on verdict publish", async (t) => {
  const l = new PolicyLedger();
  const id = l.seed();
  const m = anthropicMock({ "claude-opus-5": [NARRATION_FIXTURE], "claude-sonnet-5": [review("publish", { noIndividualsNamed: false })] });
  t.after(m.restore);
  const r = await runAnalyst({ ledger: l as unknown as AnalystLedger, journal: journal(), apiKey: "sk-test" });
  assert.deepEqual(r.held, [id]);
  assert.equal((l.events[1] as unknown as { verdict: string }).verdict, "hold");
});

test("analyst: control AOI → forced reject → false_positive, even if the reviewer says publish", async (t) => {
  const l = new PolicyLedger();
  const id = l.seed({ control: true });
  const m = anthropicMock({ "claude-opus-5": [NARRATION_FIXTURE], "claude-sonnet-5": [review("publish")] });
  t.after(m.restore);
  const r = await runAnalyst({ ledger: l as unknown as AnalystLedger, journal: journal(), apiKey: "sk-test" });
  assert.deepEqual(r.rejected, [id]);
  const [, reviewed, changed] = l.events as unknown as Record<string, unknown>[];
  assert.equal(reviewed!.verdict, "reject");
  assert.match(reviewed!.note as string, /forced reject: control AOI/);
  assert.equal(changed!.to, "false_positive");
  assert.equal(l.get(id)!.status, "false_positive");
});

test("analyst: tier 3 is narrated and reviewed but never auto-published", async (t) => {
  const l = new PolicyLedger();
  const id = l.seed({ tier: 3 });
  const m = anthropicMock({ "claude-opus-5": [NARRATION_FIXTURE], "claude-sonnet-5": [REVIEW_FIXTURE] });
  t.after(m.restore);
  const r = await runAnalyst({ ledger: l as unknown as AnalystLedger, journal: journal(), apiKey: "sk-test" });
  assert.deepEqual(r.held, [id]);
  assert.equal(l.get(id)!.status, "confirmed");
});

test("analyst: missing key → clean OverviewError, no calls, nothing written", async (t) => {
  const l = new PolicyLedger();
  l.seed();
  const m = anthropicMock({});
  t.after(m.restore);
  await assert.rejects(runAnalyst({ ledger: l as unknown as AnalystLedger, journal: journal(), apiKey: undefined }), (e: unknown) => e instanceof OverviewError && /ANTHROPIC_API_KEY is not set/.test(e.message));
  await assert.rejects(runAnalyst({ ledger: l as unknown as AnalystLedger, journal: journal(), apiKey: "k", narrator: "claude-sonnet-5" }), /must be different models/);
  assert.equal(m.api.length, 0);
  assert.equal(l.events.length, 0);
});

test("analyst: dry run makes one call per finding and appends nothing", async (t) => {
  const l = new PolicyLedger();
  l.seed();
  l.seed();
  const m = anthropicMock({ "claude-opus-5": [NARRATION_FIXTURE, withText(NARRATION_FIXTURE, { ...GOOD_NARRATION, keyNumbers: [{ label: "x", value: 1, evidenceId: "nope" }] })] });
  t.after(m.restore);
  const lines: string[] = [];
  const r = await runAnalyst({ ledger: l as unknown as AnalystLedger, journal: journal(), apiKey: "sk-test", dryRun: true, log: (s) => lines.push(s) });
  assert.equal(r.calls, 2);
  assert.equal(l.events.length, 0);
  assert.ok(lines.some((s) => /would append narrated \(model:claude-opus-5\), then review with claude-sonnet-5/.test(s)));
  assert.ok(lines.some((s) => /fails checks \(dry run: no retry\).*does not hold/.test(s)));
});

test("analyst: API errors and refusals surface as OverviewError with the status", async (t) => {
  let n = 0;
  const fm = mockFetch(() => (n++ === 0 ? jsonResponse({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, { status: 429 }) : jsonResponse({ ...REVIEW_FIXTURE, content: [], stop_reason: "refusal", stop_details: { category: "cyber" } })));
  t.after(fm.restore);
  const o = { apiKey: "k", model: "claude-sonnet-5", system: "s", user: "u", schema: {} };
  await assert.rejects(callJson(o), (e: unknown) => e instanceof OverviewError && e.status === 429 && /rate_limit_error\): slow down/.test(e.message));
  await assert.rejects(callJson(o), /model refused \(cyber\)/);
});

test("analyst checks: faithfulness, personal names, cost table", () => {
  const l = new PolicyLedger();
  const f = l.get(l.seed())!;
  assert.deepEqual(faithfulness(f, GOOD_NARRATION), []);
  const bad = faithfulness(f, { ...GOOD_NARRATION, headline: "Loss of 52 ha", keyNumbers: [{ label: "NDVI", value: 0.21, evidenceId: S2 }] });
  assert.equal(bad.length, 2);
  assert.match(bad[0]!, /"NDVI" = 0\.21 does not appear verbatim/);
  assert.match(bad[1]!, /the number 52/);
  assert.deepEqual(personalNames("Dr. Silva visited. The Amazon River basin near São Félix do Xingu, per NASA FIRMS.", "são félix do xingu"), ["Dr. Silva"]);
  assert.deepEqual(personalNames("Maria Oliveira owns the farm. Global Forest Watch and La Niña.", ""), ["Maria Oliveira"]);
  // Live false positive (2026-09-26): a month abbreviation before a line break + a sentence start.
  assert.deepEqual(personalNames("Alerts ran 28 Jun to 26 Sep\nValid pixels were 96 %. Cloud Free Composite used.", "valid pixels 96"), []);
  assert.equal(costUsd("claude-opus-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 30);
  assert.equal(costUsd("unknown-model", { input_tokens: 1, output_tokens: 1 }), null);
});

test("analyst vs the real Ledger: the narrated event satisfies today's contract", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "earthdeck-analyst-ledger-"));
  const ledger = Ledger.open(dir);
  const { event } = ledger.append({ ...createdInput(), findingId: uuidv7() });
  ledger.append(confirmedInput(event.findingId));
  const m = anthropicMock({ "claude-opus-5": [NARRATION_FIXTURE], "claude-sonnet-5": [REVIEW_FIXTURE] });
  t.after(m.restore);
  const r = await runAnalyst({ ledger, journal: journal(), apiKey: "sk-test" });
  assert.deepEqual(r.narrated, [event.findingId]);
  const f = ledger.get(event.findingId)!;
  assert.equal(f.narration?.actor, "model:claude-opus-5");
  // Until the model-review policy lands in schema.ts, the review append is refused by the
  // contract (recorded as an error, finding stays confirmed); after it lands, it publishes.
  assert.ok(["confirmed", "published"].includes(f.status));
  assert.ok(ledger.verify().ok);
});
