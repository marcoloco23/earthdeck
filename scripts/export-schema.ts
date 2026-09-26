// `pnpm schema` — write schema/finding-event.v1.json from the zod schemas.
import { mkdirSync, writeFileSync } from "node:fs";
import { findingEventJsonSchema } from "../src/ledger/jsonschema.js";

mkdirSync("schema", { recursive: true });
writeFileSync("schema/finding-event.v1.json", `${JSON.stringify(findingEventJsonSchema(), null, 2)}\n`);
process.stdout.write("wrote schema/finding-event.v1.json\n");
