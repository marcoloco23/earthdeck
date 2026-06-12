import { test } from "node:test";
import assert from "node:assert/strict";
import { validateIngest } from "../src/dashboard/server.js";

const base = () => ({ id: "abc-123", type: "imagery", ts: "2026-06-06T00:00:00Z", title: "ok", payload: {} });

test("validateIngest accepts a well-formed card", () => {
  const card = validateIngest(base());
  assert.equal(card.id, "abc-123");
  assert.equal(card.type, "imagery");
});

test("validateIngest constrains the id charset (the XSS guard)", () => {
  // The id becomes an /img/{id} key and is embedded in the UI — reject HTML-breaking ids.
  assert.throws(() => validateIngest({ ...base(), id: 'x" onerror=alert(1) "' }), /invalid id/);
  assert.throws(() => validateIngest({ ...base(), id: "a/b" }), /invalid id/);
  assert.throws(() => validateIngest({ ...base(), id: "" }), /invalid id/);
  assert.throws(() => validateIngest({ ...base(), id: "x".repeat(129) }), /invalid id/);
  assert.doesNotThrow(() => validateIngest({ ...base(), id: "A_b.9-z" }));
});

test("validateIngest allow-lists the card type", () => {
  for (const type of ["imagery", "index", "fires", "events", "compare", "search", "series", "quakes", "pulse"]) {
    assert.doesNotThrow(() => validateIngest({ ...base(), type }));
  }
  assert.throws(() => validateIngest({ ...base(), type: "evil" }), /invalid type/);
});

test("validateIngest requires the core fields", () => {
  assert.throws(() => validateIngest(null), /must be an object/);
  assert.throws(() => validateIngest({ ...base(), ts: undefined }), /ts required/);
  assert.throws(() => validateIngest({ ...base(), title: 42 }), /title required/);
  assert.throws(() => validateIngest({ ...base(), payload: undefined }), /payload required/);
});

test("validateIngest allow-lists the image mime type", () => {
  assert.doesNotThrow(() => validateIngest({ ...base(), image: { mimeType: "image/png", dataBase64: "AA==" } }));
  assert.throws(
    () => validateIngest({ ...base(), image: { mimeType: "text/html", dataBase64: "AA==" } }),
    /image\.mimeType must be/,
  );
});

test("validateIngest validates and caps the images array", () => {
  const img = { mimeType: "image/jpeg", dataBase64: "AA==" };
  assert.doesNotThrow(() => validateIngest({ ...base(), images: [img, img] }));
  assert.throws(() => validateIngest({ ...base(), images: [img, img, img, img, img] }), /max 4/);
});

test("validateIngest validates bbox shape", () => {
  assert.doesNotThrow(() => validateIngest({ ...base(), bbox: [-10, -20, 10, 20] }));
  assert.throws(() => validateIngest({ ...base(), bbox: [1, 2, 3] }), /bbox must be 4 numbers/);
});

test("validateIngest: note cards require bounded payload.text", () => {
  const note = (text: unknown) => ({ ...base(), type: "note", payload: { text, kind: "insight" } });
  assert.doesNotThrow(() => validateIngest(note("## Finding\n- NDVI fell 0.11")));
  assert.throws(() => validateIngest(note("")), /note payload\.text/);
  assert.throws(() => validateIngest(note(42)), /note payload\.text/);
  assert.throws(() => validateIngest({ ...base(), type: "note", payload: {} }), /note payload\.text/);
  assert.throws(() => validateIngest(note("x".repeat(20_001))), /note payload\.text/);
  assert.doesNotThrow(() => validateIngest(note("x".repeat(20_000))));
});
