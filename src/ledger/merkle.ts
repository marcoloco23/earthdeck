// RFC 6962 / RFC 9162 Merkle tree over SHA-256, plus the C2SP tlog-tiles static layout.
// Pure functions over Buffers — no I/O here except the tile path helpers. The verifier
// (`verifyInclusion`, `verifyConsistency`) is what a third party runs against our public
// checkpoint, so this file is deliberately boring and standard: leaf = H(0x00‖data),
// node = H(0x01‖L‖R), which makes our log checkable with off-the-shelf Go/Rust tooling.

import { createHash } from "node:crypto";

export const HASH_SIZE = 32;
export const TILE_HEIGHT = 8;
export const TILE_WIDTH = 1 << TILE_HEIGHT; // 256 hashes per tile

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

/** RFC 6962 §2.1 leaf hash. */
export function hashLeaf(data: Buffer): Buffer {
  return sha256(LEAF_PREFIX, data);
}

/** RFC 6962 §2.1 interior-node hash. */
export function hashChildren(left: Buffer, right: Buffer): Buffer {
  return sha256(NODE_PREFIX, left, right);
}

/** Largest power of two strictly less than n (n ≥ 2). */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/**
 * Merkle Tree Hash of leaf hashes [lo, hi). The empty tree hashes to SHA-256("") per
 * RFC 6962 §2.1. Works on *leaf hashes* (already prefixed), not raw entries.
 */
export function rootHash(leaves: readonly Buffer[], lo = 0, hi = leaves.length): Buffer {
  const n = hi - lo;
  if (n === 0) return sha256();
  if (n === 1) return leaves[lo]!;
  const k = splitPoint(n);
  return hashChildren(rootHash(leaves, lo, lo + k), rootHash(leaves, lo + k, hi));
}

/** RFC 6962 §2.1.1 audit path for leaf `m` in the tree of leaf hashes [lo, hi). */
export function inclusionProof(leaves: readonly Buffer[], m: number, lo = 0, hi = leaves.length): Buffer[] {
  const n = hi - lo;
  if (m < 0 || m >= n) throw new RangeError(`leaf index ${m} out of range for tree size ${n}`);
  if (n === 1) return [];
  const k = splitPoint(n);
  if (m < k) return [...inclusionProof(leaves, m, lo, lo + k), rootHash(leaves, lo + k, hi)];
  return [...inclusionProof(leaves, m - k, lo + k, hi), rootHash(leaves, lo, lo + k)];
}

/** RFC 6962 §2.1.2 consistency proof from tree size `m` to tree size `n` (0 < m ≤ n). */
export function consistencyProof(leaves: readonly Buffer[], m: number, n = leaves.length): Buffer[] {
  if (m <= 0 || m > n || n > leaves.length) throw new RangeError(`bad consistency range ${m}→${n}`);
  if (m === n) return [];
  return subProof(leaves, m, 0, n, true);
}

function subProof(leaves: readonly Buffer[], m: number, lo: number, hi: number, complete: boolean): Buffer[] {
  const n = hi - lo;
  if (m === n) return complete ? [] : [rootHash(leaves, lo, hi)];
  const k = splitPoint(n);
  if (m <= k) return [...subProof(leaves, m, lo, lo + k, complete), rootHash(leaves, lo + k, hi)];
  return [...subProof(leaves, m - k, lo + k, hi, false), rootHash(leaves, lo, lo + k)];
}

/** RFC 9162 §2.1.3.2: does `proof` bind leaf hash `leaf` at index `m` to `root` for size `n`? */
export function verifyInclusion(leaf: Buffer, m: number, n: number, proof: readonly Buffer[], root: Buffer): boolean {
  if (m < 0 || m >= n) return false;
  let fn = m;
  let sn = n - 1;
  let r = leaf;
  for (const p of proof) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = hashChildren(p, r);
      while (fn % 2 === 0 && fn !== 0) {
        fn = fn >> 1;
        sn = sn >> 1;
      }
    } else {
      r = hashChildren(r, p);
    }
    fn = fn >> 1;
    sn = sn >> 1;
  }
  return sn === 0 && r.equals(root);
}

/** RFC 9162 §2.1.4.2: does `proof` show the tree of size `m` (root1) is a prefix of size `n` (root2)? */
export function verifyConsistency(m: number, n: number, root1: Buffer, root2: Buffer, proof: readonly Buffer[]): boolean {
  if (m <= 0 || m > n) return false;
  if (m === n) return proof.length === 0 && root1.equals(root2);
  if (proof.length === 0) return false;
  let fn = m - 1;
  let sn = n - 1;
  while (fn % 2 === 1) {
    fn = fn >> 1;
    sn = sn >> 1;
  }
  let i = 0;
  let fr: Buffer;
  let sr: Buffer;
  if (fn === 0) {
    fr = root1;
    sr = root1;
  } else {
    fr = proof[0]!;
    sr = proof[0]!;
    i = 1;
  }
  for (; i < proof.length; i++) {
    const c = proof[i]!;
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      fr = hashChildren(c, fr);
      sr = hashChildren(c, sr);
      while (fn % 2 === 0 && fn !== 0) {
        fn = fn >> 1;
        sn = sn >> 1;
      }
    } else {
      sr = hashChildren(sr, c);
    }
    fn = fn >> 1;
    sn = sn >> 1;
  }
  return sn === 0 && fr.equals(root1) && sr.equals(root2);
}

// ---- C2SP tlog-tiles layout -------------------------------------------------------------
// Tile (L, N) holds up to 256 hashes: the nodes at tree level 8·L covering leaves
// [N·256^(L+1), (N+1)·256^(L+1)). Only *complete* subtrees are materialized, so the last
// tile at each level may be partial (width W < 256) and is served at `<path>.p/<W>`.

export interface Tile {
  level: number;
  index: number;
  hashes: Buffer[]; // width = hashes.length (≤ 256)
}

/** tlog-tiles path for a tile: `tile/<L>/<N>` with N split into 3-digit `x…/` elements. */
export function tilePath(level: number | "entries", index: number, width = TILE_WIDTH): string {
  const chunks: number[] = [];
  let n = index;
  do {
    chunks.unshift(n % 1000);
    n = Math.floor(n / 1000);
  } while (n > 0);
  // All but the last element carry an "x" prefix (so `x001/x234/067` can't collide with a
  // plain three-digit index at the same depth).
  const parts = chunks.map((c, i) => `${i < chunks.length - 1 ? "x" : ""}${String(c).padStart(3, "0")}`);
  const base = `tile/${level}/${parts.join("/")}`;
  return width === TILE_WIDTH ? base : `${base}.p/${width}`;
}

/**
 * Every tile the current tree of `leaves` materializes (complete subtrees only). For a
 * small log this is a handful of files; the writer rewrites just the ones that changed.
 */
export function tiles(leaves: readonly Buffer[]): Tile[] {
  const out: Tile[] = [];
  let level = 0;
  let nodes: Buffer[] = [...leaves];
  while (nodes.length > 0) {
    // Nodes at tree level 8·level: pack into tiles of 256.
    for (let i = 0; i < nodes.length; i += TILE_WIDTH) {
      out.push({ level, index: i / TILE_WIDTH, hashes: nodes.slice(i, i + TILE_WIDTH) });
    }
    // Climb 8 tree levels: hash complete 256-leaf groups into one node each.
    const next: Buffer[] = [];
    for (let i = 0; i + TILE_WIDTH <= nodes.length; i += TILE_WIDTH) {
      next.push(rootHash(nodes, i, i + TILE_WIDTH));
    }
    nodes = next;
    level++;
  }
  return out;
}
