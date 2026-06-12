import { test } from "node:test";
import assert from "node:assert/strict";
import { DashboardState } from "../src/dashboard/server.js";

const note = (id: string, text: string, ts = "2026-06-13T00:00:00Z") => ({
  id,
  type: "note" as const,
  ts,
  title: "analysis",
  payload: { text, kind: "info" },
});

test("addCard appends new ids and upserts existing ids in place (streaming updates)", () => {
  const s = new DashboardState();
  s.addCard(note("n1", "first"));
  s.addCard(note("other", "x"));
  assert.equal(s.cards.length, 2);
  assert.equal(s.cards[0]!.id, "n1");

  // Update n1: same feed position, new content, no growth.
  s.addCard(note("n1", "first\nsecond", "2026-06-13T00:01:00Z"));
  assert.equal(s.cards.length, 2, "upsert must not append");
  assert.equal(s.cards[0]!.id, "n1", "updated card keeps its position");
  assert.equal((s.cards[0]!.payload as { text: string }).text, "first\nsecond");
  assert.equal(s.cards[0]!.ts, "2026-06-13T00:01:00Z");
});

test("addCard broadcasts updates to SSE clients", () => {
  const s = new DashboardState();
  const lines: string[] = [];
  s.clients.add({ write: (l: string) => lines.push(l) } as never);
  s.addCard(note("n1", "v1"));
  s.addCard(note("n1", "v2"));
  assert.equal(lines.length, 2, "every upsert is re-broadcast");
  assert.ok(lines[1]!.includes('"v2"'));
});

test("addCard replaces the stored image when an imagery card is updated", () => {
  const s = new DashboardState();
  const img = (b64: string) => ({
    id: "i1",
    type: "imagery" as const,
    ts: "t",
    title: "img",
    payload: {},
    image: { mimeType: "image/png", dataBase64: b64 },
  });
  s.addCard(img(Buffer.from("one").toString("base64")));
  s.addCard(img(Buffer.from("two").toString("base64")));
  assert.equal(s.cards.length, 1);
  assert.equal(s.images.get("i1")!.buf.toString(), "two");
});
