// schema/finding-event.v1.json: generated from zod, committed, and faithful. A drift test
// keeps the file in sync; a sample of valid/invalid events must get the same verdict from
// the JSON Schema as from zod. The 2020-12 validator is Ajv as already installed under the
// MCP SDK (no new dependency); if it ever disappears, the structural checks still run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedDemo } from "../src/ledger/cli.js";
import { findingEventJsonSchema } from "../src/ledger/jsonschema.js";
import { eventPayload, statement, type FindingEvent } from "../src/ledger/schema.js";
import { Ledger } from "../src/ledger/store.js";

const committed = JSON.parse(readFileSync(new URL("../schema/finding-event.v1.json", import.meta.url), "utf8")) as Record<string, any>;

function seededEvents(): { events: FindingEvent[]; lines: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "earthdeck-schema-"));
  const l = Ledger.open(dir);
  seedDemo(l);
  const events = l.list().flatMap((f) => l.eventsOf(f.findingId));
  const lines = Array.from({ length: l.size }, (_, i) => l.entry(i)!);
  return { events, lines };
}

function invalidSamples(ev: FindingEvent[]): unknown[] {
  const created = ev.find((e) => e.kind === "created")!;
  const confirmed = ev.find((e) => e.kind === "confirmed")!;
  return [
    { ...created, evidence: [] }, // no finding without evidence
    { ...created, actor: "anonymous" }, // actors are never anonymous
    { ...created, at: "2026-09-01 06:00" }, // RFC 3339 Z only
    { ...created, v: 2 },
    { ...created, kind: "deleted" }, // nothing is deleted
    { ...created, tier: 4 },
    { ...confirmed, independence: "llm" }, // never an LLM judge
    { kind: "attributed", ...base(created), subject: { kind: "person", name: "J. Doe" }, reviewers: [] },
    { kind: "status_changed", ...base(created), from: "candidate", to: "gone" },
    { kind: "narrated", ...base(created), text: "x", model: { id: "m" }, promptSha256: "nothex", evidenceRefs: ["a"] },
  ];
}

function base(e: FindingEvent) {
  return { v: 1, eventId: e.eventId, findingId: e.findingId, at: e.at, actor: e.actor, prev: "a".repeat(64) };
}

test("json schema: committed file matches the zod-generated schema (run `pnpm schema`)", () => {
  assert.deepEqual(committed, JSON.parse(JSON.stringify(findingEventJsonSchema())));
});

test("json schema: structure — 2020-12, one branch per event kind, statement → event", () => {
  assert.equal(committed.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(committed.$ref, "#/$defs/FindingEvent");
  const branches = committed.$defs.FindingEvent.oneOf as Record<string, any>[];
  const kinds = branches.map((b) => b.properties.kind.const).sort();
  assert.deepEqual(kinds, ["attributed", "commented", "confirmed", "created", "evidence_added", "narrated", "notified", "replied", "retracted", "reviewed", "status_changed"]);
  for (const b of branches) {
    for (const k of ["v", "eventId", "findingId", "at", "actor", "prev", "kind"]) assert.ok(b.required.includes(k), `${b.properties.kind.const} requires ${k}`);
  }
  const created = branches.find((b) => b.properties.kind.const === "created")!;
  assert.equal(created.properties.evidence.minItems, 1);
  const attributed = branches.find((b) => b.properties.kind.const === "attributed")!;
  assert.deepEqual(attributed.properties.subject.properties.kind.enum, ["asset", "place", "institution"]);
  assert.deepEqual(committed.$defs.Statement.properties.predicate, { $ref: "#/$defs/FindingEvent" });
  assert.equal(committed.$defs.Envelope.properties.payloadType.const, "application/vnd.in-toto+json");
});

test("json schema: same verdict as zod on real ledger events and on invalid samples", (t) => {
  let Ajv2020: any;
  try {
    const sdk = fileURLToPath(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"));
    Ajv2020 = createRequire(sdk)("ajv/dist/2020").default;
  } catch {
    t.skip("ajv not resolvable via the MCP SDK — structural test still covers the schema");
    return;
  }
  // `format` (uri) is an annotation in 2020-12 unless asserted; zod checks URLs, so leave formats off.
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const validateEvent = ajv.compile(committed);
  const validateStatement = ajv.getSchema(`${committed.$id}#/$defs/Statement`);
  const validateEnvelope = ajv.getSchema(`${committed.$id}#/$defs/Envelope`);

  const { events, lines } = seededEvents();
  assert.ok(events.length >= 8);
  for (const ev of events) {
    assert.equal(eventPayload.safeParse(ev).success, true);
    assert.equal(validateEvent(ev), true, `${ev.kind}: ${JSON.stringify(validateEvent.errors)}`);
  }
  for (const line of lines) {
    const env = JSON.parse(line);
    assert.equal(validateEnvelope(env), true, JSON.stringify(validateEnvelope.errors));
    const stmt = JSON.parse(Buffer.from(env.payload, "base64").toString("utf8"));
    assert.equal(statement.safeParse(stmt).success, true);
    assert.equal(validateStatement(stmt), true, JSON.stringify(validateStatement.errors));
  }
  for (const bad of invalidSamples(events)) {
    assert.equal(eventPayload.safeParse(bad).success, false, `zod should reject ${JSON.stringify(bad).slice(0, 80)}`);
    assert.equal(validateEvent(bad), false, `schema should reject ${JSON.stringify(bad).slice(0, 80)}`);
  }
});
