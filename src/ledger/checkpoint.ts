// C2SP tlog-checkpoint: a "signed note" carrying the log origin, tree size and root hash.
//
//   earthdeck.dev/findings/v1\n
//   42\n
//   <base64 root hash>\n
//   \n
//   — earthdeck <base64(4-byte key hash ‖ Ed25519 signature)>\n
//
// The signature covers everything before the blank line. Rules we inherit from the spec:
// a log MUST NOT sign a checkpoint inconsistent with one it previously signed (enforced in
// store.ts via a consistency proof on every append), and verifiers MUST ignore unknown
// signatures — which is what lets keys rotate and witnesses cosign later without a format
// change. Ed25519 via node:crypto; no dependencies.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

export const ORIGIN = "earthdeck.dev/findings/v1";
export const KEY_NAME = "earthdeck";

const ED25519_KEY_TYPE = 0x01; // signed-note algorithm id for Ed25519
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface SigningKey {
  name: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** Raw 32-byte Ed25519 public key. */
  publicRaw: Buffer;
  /** First 4 bytes of SHA-256(name ‖ "\n" ‖ 0x01 ‖ pubkey) — identifies the key in a signature line. */
  keyHash: Buffer;
}

export interface VerifyingKey {
  name: string;
  publicKey: KeyObject;
  keyHash: Buffer;
}

export interface Checkpoint {
  origin: string;
  size: number;
  root: Buffer;
  /** Signature lines that verified against a known key, by key name. */
  signedBy: string[];
}

function keyHashOf(name: string, publicRaw: Buffer): Buffer {
  return createHash("sha256")
    .update(name)
    .update("\n")
    .update(Buffer.from([ED25519_KEY_TYPE]))
    .update(publicRaw)
    .digest()
    .subarray(0, 4);
}

/** Build a signing key from a 32-byte Ed25519 seed. */
export function keyFromSeed(seed: Buffer, name = KEY_NAME): SigningKey {
  if (seed.length !== 32) throw new Error("Ed25519 seed must be 32 bytes");
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const publicRaw = publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);
  return { name, privateKey, publicKey, publicRaw: Buffer.from(publicRaw), keyHash: keyHashOf(name, Buffer.from(publicRaw)) };
}

/** Generate a fresh key; returns it with the seed so the caller can persist it. */
export function generateKey(name = KEY_NAME): { key: SigningKey; seed: Buffer } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8_PREFIX.length));
  return { key: keyFromSeed(seed, name), seed };
}

/** Verifying key from a raw 32-byte public key (what we publish in `ledger.pub`). */
export function verifyingKey(publicRaw: Buffer, name = KEY_NAME): VerifyingKey {
  const publicKey = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicRaw]), format: "der", type: "spki" });
  return { name, publicKey, keyHash: keyHashOf(name, publicRaw) };
}

/** The note body (signed portion) for a tree state. */
export function noteText(size: number, root: Buffer, origin = ORIGIN): string {
  return `${origin}\n${size}\n${root.toString("base64")}\n`;
}

/** Produce a signed checkpoint. */
export function signCheckpoint(size: number, root: Buffer, key: SigningKey, origin = ORIGIN): string {
  const text = noteText(size, root, origin);
  const sig = sign(null, Buffer.from(text, "utf8"), key.privateKey);
  const line = `— ${key.name} ${Buffer.concat([key.keyHash, sig]).toString("base64")}\n`;
  return `${text}\n${line}`;
}

/**
 * Parse a checkpoint and verify its signatures against `keys`. Throws on malformed input;
 * returns `signedBy: []` (not an error) when no known key signed it — the caller decides
 * whether that's acceptable. Unknown signature lines are ignored per the spec.
 */
export function parseCheckpoint(text: string, keys: readonly VerifyingKey[], origin = ORIGIN): Checkpoint {
  const sep = text.indexOf("\n\n");
  if (sep < 0) throw new Error("checkpoint: missing signature separator");
  const body = text.slice(0, sep + 1);
  const sigBlock = text.slice(sep + 2);
  const lines = body.split("\n");
  if (lines.length < 4 || lines[0] !== origin) throw new Error(`checkpoint: unexpected origin ${JSON.stringify(lines[0])}`);
  const size = Number(lines[1]);
  if (!Number.isInteger(size) || size < 0 || String(size) !== lines[1]) throw new Error("checkpoint: bad tree size");
  const root = Buffer.from(lines[2]!, "base64");
  if (root.length !== 32) throw new Error("checkpoint: bad root hash");

  const signedBy: string[] = [];
  for (const line of sigBlock.split("\n")) {
    if (line === "") continue;
    const m = line.match(/^— (\S+) (\S+)$/);
    if (!m) throw new Error("checkpoint: malformed signature line");
    const blob = Buffer.from(m[2]!, "base64");
    if (blob.length < 4) throw new Error("checkpoint: short signature");
    const hash = blob.subarray(0, 4);
    const sig = blob.subarray(4);
    for (const k of keys) {
      if (k.name !== m[1] || !k.keyHash.equals(hash)) continue;
      if (verify(null, Buffer.from(body, "utf8"), k.publicKey, sig)) signedBy.push(k.name);
      else throw new Error(`checkpoint: invalid signature by ${k.name}`);
    }
  }
  return { origin, size, root, signedBy };
}
