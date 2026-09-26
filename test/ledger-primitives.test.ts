// The ledger's trust root: RFC 8785 canonicalization, RFC 6962/9162 Merkle math, and the
// C2SP signed-note checkpoint. All vectors are from the RFCs themselves so a Node upgrade
// or a refactor can't silently change the bytes we hash and sign.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalize } from "../src/ledger/jcs.js";
import {
  consistencyProof,
  hashLeaf,
  inclusionProof,
  rootHash,
  tilePath,
  tiles,
  verifyConsistency,
  verifyInclusion,
  TILE_WIDTH,
} from "../src/ledger/merkle.js";
import { generateKey, keyFromSeed, parseCheckpoint, signCheckpoint, verifyingKey, ORIGIN } from "../src/ledger/checkpoint.js";
import { uuidv7 } from "../src/util.js";

// ---- RFC 8785 ---------------------------------------------------------------------------

test("JCS: RFC 8785 §3.2.3 structure vector", () => {
  const input = JSON.parse(
    '{"1":{"f":{"f":"hi","F":5},"\\n":56.0},"10":{},"":"empty","a":{},"111":[{"e":"yes","E":"no"}],"A":{}}',
  );
  assert.equal(
    canonicalize(input),
    '{"":"empty","1":{"\\n":56,"f":{"F":5,"f":"hi"}},"10":{},"111":[{"E":"no","e":"yes"}],"A":{},"a":{}}',
  );
});

test("JCS: RFC 8785 unicode key ordering (UTF-16 code units)", () => {
  const input = JSON.parse(
    '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control","\\u00f6":"Latin Small Letter O With Diaeresis"}',
  );
  assert.equal(
    canonicalize(input),
    '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
  );
});

test("JCS: RFC 8785 number serialization", () => {
  const input = JSON.parse('{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"literals":[null,true,false]}');
  assert.equal(canonicalize(input), '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}');
  assert.equal(canonicalize(-0), "0");
  assert.throws(() => canonicalize({ a: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalize({ a: undefined }), /undefined/);
});

// ---- RFC 6962 / RFC 9162 -----------------------------------------------------------------

// RFC 9162 §2.1.5 test-vector leaves.
const VECTOR_LEAVES = ["", "00", "10", "2021", "3031", "40414243", "5051525354555657", "606162636465666768696a6b6c6d6e6f"].map(
  (hex) => hashLeaf(Buffer.from(hex, "hex")),
);
const VECTOR_ROOTS = [
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", // empty
  "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
  "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
  "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
  "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
  "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
  "76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
  "ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
  "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328",
];

test("Merkle: RFC 9162 root hashes for tree sizes 0..8", () => {
  for (let n = 0; n <= 8; n++) {
    assert.equal(rootHash(VECTOR_LEAVES.slice(0, n)).toString("hex"), VECTOR_ROOTS[n], `size ${n}`);
  }
});

test("Merkle: RFC 9162 inclusion proof vectors", () => {
  // leaf 0 of size 8 (RFC 9162 §2.1.5)
  const p0 = inclusionProof(VECTOR_LEAVES, 0).map((b) => b.toString("hex"));
  assert.deepEqual(p0, [
    "96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7",
    "5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e",
    "6b47aaf29ee3c2af9af889bc1fb9254dabd31177f16232dd6aab035ca39bf6e4",
  ]);
  // leaf 5 of size 8
  const p5 = inclusionProof(VECTOR_LEAVES, 5).map((b) => b.toString("hex"));
  assert.deepEqual(p5, [
    "bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b",
    "ca854ea128ed050b41b35ffc1b87b8eb2bde461e9e3b5596ece6b9d5975a0ae0",
    "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
  ]);
});

test("Merkle: every inclusion proof verifies, and fails against a tampered leaf", () => {
  for (let n = 1; n <= 8; n++) {
    const leaves = VECTOR_LEAVES.slice(0, n);
    const root = rootHash(leaves);
    for (let m = 0; m < n; m++) {
      const proof = inclusionProof(leaves, m);
      assert.ok(verifyInclusion(leaves[m]!, m, n, proof, root), `size ${n} leaf ${m}`);
      assert.ok(!verifyInclusion(hashLeaf(Buffer.from("tampered")), m, n, proof, root));
    }
  }
});

test("Merkle: RFC 9162 consistency proof vectors", () => {
  const hex = (bs: Buffer[]) => bs.map((b) => b.toString("hex"));
  assert.deepEqual(hex(consistencyProof(VECTOR_LEAVES, 1, 1)), []);
  assert.deepEqual(hex(consistencyProof(VECTOR_LEAVES, 1, 8)), [
    "96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7",
    "5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e",
    "6b47aaf29ee3c2af9af889bc1fb9254dabd31177f16232dd6aab035ca39bf6e4",
  ]);
  assert.deepEqual(hex(consistencyProof(VECTOR_LEAVES, 6, 8)), [
    "0ebc5d3437fbe2db158b9f126a1d118e308181031d0a949f8dededebc558ef6a",
    "ca854ea128ed050b41b35ffc1b87b8eb2bde461e9e3b5596ece6b9d5975a0ae0",
    "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
  ]);
  assert.deepEqual(hex(consistencyProof(VECTOR_LEAVES, 2, 5)), [
    "5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e",
    "bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b",
  ]);
});

test("Merkle: every consistency proof verifies; a rewritten history does not", () => {
  for (let n = 1; n <= 8; n++) {
    for (let m = 1; m <= n; m++) {
      const proof = consistencyProof(VECTOR_LEAVES, m, n);
      const r1 = rootHash(VECTOR_LEAVES.slice(0, m));
      const r2 = rootHash(VECTOR_LEAVES.slice(0, n));
      assert.ok(verifyConsistency(m, n, r1, r2, proof), `${m}→${n}`);
    }
  }
  // Rewrite leaf 1 after a checkpoint at size 3 was published: the old root no longer
  // extends to the new tree, which is exactly the split-view a verifier must catch.
  const forked = [...VECTOR_LEAVES];
  forked[1] = hashLeaf(Buffer.from("rewritten"));
  const oldRoot = rootHash(VECTOR_LEAVES.slice(0, 3));
  assert.ok(!verifyConsistency(3, 8, oldRoot, rootHash(forked), consistencyProof(forked, 3, 8)));
});

test("tlog-tiles: paths and tile materialization", () => {
  assert.equal(tilePath(0, 0), "tile/0/000");
  assert.equal(tilePath(0, 1234067), "tile/0/x001/x234/067");
  assert.equal(tilePath(0, 5, 17), "tile/0/005.p/17");
  assert.equal(tilePath("entries", 0), "tile/entries/000");

  const leaves = Array.from({ length: TILE_WIDTH + 3 }, (_, i) => hashLeaf(Buffer.from(`e${i}`)));
  const ts = tiles(leaves);
  // Level 0: one full tile + one partial of width 3. Level 1: one partial tile of width 1.
  assert.deepEqual(
    ts.map((t) => [t.level, t.index, t.hashes.length]),
    [
      [0, 0, TILE_WIDTH],
      [0, 1, 3],
      [1, 0, 1],
    ],
  );
  assert.ok(ts[2]!.hashes[0]!.equals(rootHash(leaves, 0, TILE_WIDTH)));
});

// ---- Checkpoint ---------------------------------------------------------------------------

test("checkpoint: sign → parse round-trip; tampering and wrong key are rejected", () => {
  const seed = createHash("sha256").update("earthdeck test seed").digest();
  const key = keyFromSeed(seed);
  const root = rootHash(VECTOR_LEAVES);
  const text = signCheckpoint(8, root, key);
  assert.match(text, new RegExp(`^${ORIGIN}\\n8\\n[A-Za-z0-9+/=]+\\n\\n— earthdeck [A-Za-z0-9+/=]+\\n$`));

  const pub = verifyingKey(key.publicRaw);
  const cp = parseCheckpoint(text, [pub]);
  assert.equal(cp.size, 8);
  assert.ok(cp.root.equals(root));
  assert.deepEqual(cp.signedBy, ["earthdeck"]);

  // Same key rebuilt from the seed yields the same key hash (deterministic identity).
  assert.ok(keyFromSeed(seed).keyHash.equals(key.keyHash));

  // Tamper with the size → signature invalid.
  assert.throws(() => parseCheckpoint(text.replace("\n8\n", "\n9\n"), [pub]), /invalid signature/);
  // An unknown key's signature is ignored, not an error (spec rule) → signedBy empty.
  const other = generateKey().key;
  assert.deepEqual(parseCheckpoint(text, [verifyingKey(other.publicRaw)]).signedBy, []);
  assert.throws(() => parseCheckpoint("garbage", [pub]), /separator/);
});

test("uuidv7: version/variant bits and time ordering", () => {
  const a = uuidv7(1_700_000_000_000);
  const b = uuidv7(1_700_000_000_001);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(a < b);
});
