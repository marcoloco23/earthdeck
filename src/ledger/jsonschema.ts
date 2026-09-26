// The finding-event contract as JSON Schema 2020-12, derived from the zod schemas in
// schema.ts (zod is the runtime truth; this is the portable, published form). Written to
// `schema/finding-event.v1.json` by `pnpm schema`; a test fails if the two drift.
// Only per-event shape is expressible here — the trust contract's state rules
// (transitions, reviewers, publishability) live in `checkAppend` and are not in the schema.

import { z } from "zod";
import { envelope, eventPayload, PREDICATE_TYPE, statement } from "./schema.js";

export const FINDING_EVENT_SCHEMA_ID = "https://earthdeck.dev/schema/finding-event.v1.json";

type Json = Record<string, unknown>;

function toJson(schema: z.ZodType): Json {
  // Output mode: what a stored (already-parsed) event looks like — defaults are filled in.
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" }) as Json;
  return rest;
}

/** Build the published schema: FindingEvent (root), plus Statement and Envelope in `$defs`. */
export function findingEventJsonSchema(): Json {
  const stmt = toJson(statement);
  (stmt.properties as Json).predicate = { $ref: "#/$defs/FindingEvent" };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: FINDING_EVENT_SCHEMA_ID,
    title: "earthdeck finding event v1",
    description:
      `One event of a finding (predicate \`${PREDICATE_TYPE}\`). Ledger lines are DSSE ` +
      "Envelopes whose base64 payload is a JCS-canonical in-toto Statement whose predicate is " +
      "this event. State rules (legal transitions, reviewer counts, publishability) are " +
      "enforced by the ledger (src/ledger/schema.ts checkAppend), not by this schema. " +
      "Generated from the zod schemas — do not edit by hand; run `pnpm schema`.",
    $ref: "#/$defs/FindingEvent",
    $defs: {
      FindingEvent: toJson(eventPayload),
      Statement: stmt,
      Envelope: toJson(envelope),
    },
  };
}
