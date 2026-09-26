// In-browser verification of a case against the public ledger, with WebCrypto only:
//   1. the checkpoint's Ed25519 signature against ledger/pub (C2SP signed note),
//   2. the case's leaf hash against the level-0 tlog tile that holds it,
//   3. the RFC 9162 inclusion proof from that leaf up to the signed root.
// Mirrors src/ledger/{checkpoint,merkle}.ts; test/site-export.test.ts checks them against
// each other. Full re-derivation (every entry's signature + the trust rules) is the CLI's job.

type Bytes = Uint8Array<ArrayBuffer>;
const TILE_WIDTH = 256;
const enc = new TextEncoder();

export function hexToBytes(hex: string): Bytes {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function b64ToBytes(s: string): Bytes {
  const bin = atob(s.trim());
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function sha256(...parts: Uint8Array[]): Promise<Bytes> {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

const node = (l: Uint8Array, r: Uint8Array) => sha256(Uint8Array.of(1), l, r);

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** RFC 9162 §2.1.3.2 — does `proof` bind `leaf` at `index` to `root` for a tree of `size`? */
export async function verifyInclusion(leafHex: string, index: number, size: number, proofHex: readonly string[], rootHex: string): Promise<boolean> {
  if (index < 0 || index >= size) return false;
  let fn = index;
  let sn = size - 1;
  let r = hexToBytes(leafHex);
  for (const ph of proofHex) {
    const p = hexToBytes(ph);
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = await node(p, r);
      while (fn % 2 === 0 && fn !== 0) {
        fn >>= 1;
        sn >>= 1;
      }
    } else {
      r = await node(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && equal(r, hexToBytes(rootHex));
}

/** C2SP tlog-tiles path (same as src/ledger/merkle.ts `tilePath`). */
export function tilePath(level: number, index: number, width = TILE_WIDTH): string {
  const chunks: number[] = [];
  let n = index;
  do {
    chunks.unshift(n % 1000);
    n = Math.floor(n / 1000);
  } while (n > 0);
  const parts = chunks.map((c, i) => `${i < chunks.length - 1 ? "x" : ""}${String(c).padStart(3, "0")}`);
  const base = `tile/${level}/${parts.join("/")}`;
  return width === TILE_WIDTH ? base : `${base}.p/${width}`;
}

/** The level-0 tile holding leaf `index` in a tree of `size`, and the leaf's offset in it. */
export function leafTile(index: number, size: number): { path: string; offset: number } {
  const t = Math.floor(index / TILE_WIDTH);
  const width = Math.min(TILE_WIDTH, size - t * TILE_WIDTH);
  return { path: tilePath(0, t, width), offset: (index % TILE_WIDTH) * 32 };
}

export interface ParsedCheckpoint {
  origin: string;
  size: number;
  rootHex: string;
  body: string;
  signatures: { name: string; keyHash: Bytes; sig: Bytes }[];
}

export function parseCheckpoint(text: string): ParsedCheckpoint | null {
  const sep = text.indexOf("\n\n");
  if (sep < 0) return null;
  const body = text.slice(0, sep + 1);
  const [origin, sizeS, rootB64] = body.split("\n");
  const size = Number(sizeS);
  if (!origin || !rootB64 || !Number.isInteger(size)) return null;
  const signatures: ParsedCheckpoint["signatures"] = [];
  for (const line of text.slice(sep + 2).split("\n")) {
    const m = /^— (\S+) (\S+)$/.exec(line);
    if (!m) continue;
    try {
      const blob = b64ToBytes(m[2]!);
      if (blob.length === 68) signatures.push({ name: m[1]!, keyHash: blob.slice(0, 4), sig: blob.slice(4) });
    } catch {
      /* ignore unknown/malformed signature lines, as the spec says */
    }
  }
  return { origin, size, rootHex: bytesToHex(b64ToBytes(rootB64)), body, signatures };
}

/**
 * Verify the checkpoint signature with the published raw Ed25519 key. Returns null when the
 * browser has no Ed25519 in WebCrypto (older Safari/Chrome) — "can't tell", not "invalid".
 */
export async function verifyCheckpointSignature(cp: ParsedCheckpoint, pubB64: string, name = "earthdeck"): Promise<boolean | null> {
  const pub = b64ToBytes(pubB64);
  const keyHash = (await sha256(enc.encode(`${name}\n`), Uint8Array.of(1), pub)).slice(0, 4);
  const s = cp.signatures.find((x) => x.name === name && equal(x.keyHash, keyHash));
  if (!s) return false;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return null;
  }
  return crypto.subtle.verify({ name: "Ed25519" }, key, s.sig, enc.encode(cp.body));
}
