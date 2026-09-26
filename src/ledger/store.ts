// The ledger on disk. One directory:
//
//   entries.jsonl   one DSSE envelope per line (JCS-canonical), the append-only log
//   checkpoint      C2SP signed note over the RFC 6962 root of all lines
//   tile/…          tlog-tiles hash tiles (static files a third party can fetch)
//   ledger.key      base64 Ed25519 seed (0600) — or set EARTHDECK_LEDGER_KEY instead
//   ledger.pub      base64 raw public key — publish this
//
// `append` validates the event against the finding's projection (the trust contract in
// schema.ts), signs it, appends the line, rewrites the affected tiles, proves the new
// tree is consistent with the last signed checkpoint, and only then signs a new one.
// `verify` re-derives everything from `entries.jsonl` and is what `earthdeck ledger verify`
// (and anyone else) runs.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sign, verify as cryptoVerify } from "node:crypto";
import { canonicalize } from "./jcs.js";
import { consistencyProof, hashLeaf, inclusionProof, rootHash, tilePath, tiles, verifyConsistency } from "./merkle.js";
import {
  generateKey,
  keyFromSeed,
  parseCheckpoint,
  signCheckpoint,
  verifyingKey,
  type SigningKey,
  type VerifyingKey,
} from "./checkpoint.js";
import {
  applyEvent,
  checkAppend,
  dssePae,
  envelope as envelopeSchema,
  eventHash,
  statement as statementSchema,
  toStatement,
  PAYLOAD_TYPE,
  type Envelope,
  type Finding,
  type FindingEvent,
  type Status,
} from "./schema.js";
import { uuidv7, nowIso } from "../util.js";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What a writer supplies; the store fills `v`, `eventId`, `at` (unless given) and `prev`. */
export type EventInput = DistributiveOmit<FindingEvent, "v" | "eventId" | "prev" | "at"> & { at?: string };

export interface VerifyProblem {
  index?: number;
  message: string;
}
export interface VerifyReport {
  ok: boolean;
  size: number;
  root: string;
  signedBy: string[];
  findings: number;
  problems: VerifyProblem[];
}

export interface OpenOptions {
  /** Explicit signing key (else EARTHDECK_LEDGER_KEY, else `<dir>/ledger.key`). */
  key?: SigningKey;
  /** Base64 Ed25519 seed from the environment. */
  keySeedBase64?: string;
  /** Generate `ledger.key` when none exists (writers); readers pass false. Default true. */
  createKey?: boolean;
}

export class Ledger {
  private lines: string[] = [];
  private leaves: Buffer[] = [];
  private findings = new Map<string, Finding>();
  private eventsByFinding = new Map<string, FindingEvent[]>();
  private indexByEvent = new Map<string, number>();
  private partialTiles = new Map<string, string>(); // "L/N" → last written partial path

  private constructor(
    readonly dir: string,
    private readonly key: SigningKey | null,
    private readonly verifyKeys: VerifyingKey[],
  ) {}

  static open(dir: string, opts: OpenOptions = {}): Ledger {
    mkdirSync(join(dir, "tile"), { recursive: true });
    const key = loadKey(dir, opts);
    const verifyKeys: VerifyingKey[] = [];
    if (key) verifyKeys.push(verifyingKey(key.publicRaw, key.name));
    else if (existsSync(join(dir, "ledger.pub"))) {
      verifyKeys.push(verifyingKey(Buffer.from(readFileSync(join(dir, "ledger.pub"), "utf8").trim(), "base64")));
    }
    const ledger = new Ledger(dir, key, verifyKeys);
    ledger.load();
    return ledger;
  }

  /** Public key (base64 raw) — what verifiers need. */
  get publicKeyBase64(): string | null {
    return this.key ? this.key.publicRaw.toString("base64") : null;
  }

  get size(): number {
    return this.lines.length;
  }

  root(): Buffer {
    return rootHash(this.leaves);
  }

  checkpointText(): string | null {
    const p = join(this.dir, "checkpoint");
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }

  /** Raw envelope line at `index` (what a leaf hash covers). */
  entry(index: number): string | undefined {
    return this.lines[index];
  }

  inclusionProof(index: number): { leafHash: string; proof: string[]; size: number; root: string } {
    return {
      leafHash: this.leaves[index]!.toString("hex"),
      proof: inclusionProof(this.leaves, index).map((b) => b.toString("hex")),
      size: this.size,
      root: this.root().toString("hex"),
    };
  }

  list(filter: { status?: Status[]; publicOnly?: boolean } = {}): Finding[] {
    let out = [...this.findings.values()];
    if (filter.status) out = out.filter((f) => filter.status!.includes(f.status));
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  get(findingId: string): Finding | undefined {
    return this.findings.get(findingId);
  }

  eventsOf(findingId: string): FindingEvent[] {
    return [...(this.eventsByFinding.get(findingId) ?? [])];
  }

  /** Leaf index of an event in the log (for inclusion proofs). */
  eventIndex(eventId: string): number | undefined {
    return this.indexByEvent.get(eventId);
  }

  /** Validate, sign, append, re-tile, re-checkpoint. Throws (and writes nothing) on any rule violation. */
  append(input: EventInput): { event: FindingEvent; index: number } {
    if (!this.key) throw new Error("ledger opened read-only (no signing key)");
    const findingId = input.kind === "created" ? (input.findingId ?? uuidv7()) : input.findingId;
    const current = this.findings.get(findingId) ?? null;
    const candidate = {
      ...input,
      v: 1,
      eventId: uuidv7(),
      findingId,
      at: input.at ?? nowIso(),
      prev: current ? current.lastEventHash : null,
    };
    const ev = statementSchema.shape.predicate.parse(candidate);
    checkAppend(current, ev);

    const stmt = toStatement(ev);
    const payload = Buffer.from(canonicalize(stmt), "utf8");
    const sig = sign(null, dssePae(PAYLOAD_TYPE, payload), this.key.privateKey);
    const env: Envelope = {
      payloadType: PAYLOAD_TYPE,
      payload: payload.toString("base64"),
      signatures: [{ keyid: this.key.keyHash.toString("hex"), sig: sig.toString("base64") }],
    };
    const line = canonicalize(env);

    // Prove the new tree extends the last signed one before we sign anything new.
    const prevCp = this.checkpointText();
    const nextLeaves = [...this.leaves, hashLeaf(Buffer.from(line, "utf8"))];
    if (prevCp) {
      const cp = parseCheckpoint(prevCp, this.verifyKeys);
      const proof = consistencyProof(nextLeaves, cp.size, nextLeaves.length);
      if (!verifyConsistency(cp.size, nextLeaves.length, cp.root, rootHash(nextLeaves), proof)) {
        throw new Error("refusing to sign: new tree is not consistent with the last checkpoint");
      }
    }

    appendFileSync(join(this.dir, "entries.jsonl"), `${line}\n`);
    this.lines.push(line);
    this.leaves = nextLeaves;
    this.fold(ev, this.lines.length - 1);
    this.writeTiles();
    atomicWrite(join(this.dir, "checkpoint"), signCheckpoint(this.size, this.root(), this.key));
    return { event: ev, index: this.size - 1 };
  }

  /** Independent re-derivation of everything from `entries.jsonl`. Never throws; reports. */
  verify(opts: { trustedCheckpoint?: string } = {}): VerifyReport {
    const problems: VerifyProblem[] = [];
    const path = join(this.dir, "entries.jsonl");
    const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
    const lines = raw === "" ? [] : raw.replace(/\n$/, "").split("\n");
    const leaves: Buffer[] = [];
    const findings = new Map<string, Finding>();

    lines.forEach((line, index) => {
      leaves.push(hashLeaf(Buffer.from(line, "utf8")));
      let env: Envelope;
      try {
        const parsed: unknown = JSON.parse(line);
        if (canonicalize(parsed) !== line) problems.push({ index, message: "line is not in canonical (RFC 8785) form" });
        env = envelopeSchema.parse(parsed);
      } catch (e) {
        problems.push({ index, message: `malformed envelope: ${(e as Error).message}` });
        return;
      }
      const payload = Buffer.from(env.payload, "base64");
      if (this.verifyKeys.length === 0) {
        problems.push({ index, message: "no public key available to verify the signature" });
      } else {
        const ok = env.signatures.some((s) =>
          this.verifyKeys.some(
            (k) => s.keyid === k.keyHash.toString("hex") && cryptoVerify(null, dssePae(env.payloadType, payload), k.publicKey, Buffer.from(s.sig, "base64")),
          ),
        );
        if (!ok) problems.push({ index, message: "no valid signature by a known key" });
      }
      let ev: FindingEvent;
      try {
        const stmt = statementSchema.parse(JSON.parse(payload.toString("utf8")));
        ev = stmt.predicate;
        if (stmt.subject[0]!.name !== ev.findingId || stmt.subject[0]!.digest.sha256 !== eventHash(ev)) {
          problems.push({ index, message: "statement subject does not match its predicate" });
        }
      } catch (e) {
        problems.push({ index, message: `invalid statement: ${(e as Error).message}` });
        return;
      }
      const current = findings.get(ev.findingId) ?? null;
      try {
        checkAppend(current, ev);
        findings.set(ev.findingId, applyEvent(current, ev));
      } catch (e) {
        problems.push({ index, message: `rule violation: ${(e as Error).message}` });
      }
    });

    const root = rootHash(leaves);
    let signedBy: string[] = [];
    const cpText = this.checkpointText();
    if (!cpText) {
      if (lines.length > 0) problems.push({ message: "no checkpoint file" });
    } else {
      try {
        const cp = parseCheckpoint(cpText, this.verifyKeys);
        signedBy = cp.signedBy;
        if (cp.size !== lines.length) problems.push({ message: `checkpoint size ${cp.size} ≠ ${lines.length} entries` });
        if (!cp.root.equals(root)) problems.push({ message: "checkpoint root ≠ recomputed root (entries were altered)" });
        if (this.verifyKeys.length > 0 && signedBy.length === 0) problems.push({ message: "checkpoint not signed by a known key" });
      } catch (e) {
        problems.push({ message: `bad checkpoint: ${(e as Error).message}` });
      }
    }
    if (opts.trustedCheckpoint) {
      try {
        const t = parseCheckpoint(opts.trustedCheckpoint, this.verifyKeys);
        if (t.size > leaves.length) problems.push({ message: `log shrank: trusted size ${t.size} > current ${leaves.length}` });
        else if (t.size > 0 && !verifyConsistency(t.size, leaves.length, t.root, root, consistencyProof(leaves, t.size))) {
          problems.push({ message: "log is NOT consistent with the trusted checkpoint (history rewritten)" });
        }
      } catch (e) {
        problems.push({ message: `bad trusted checkpoint: ${(e as Error).message}` });
      }
    }
    return { ok: problems.length === 0, size: lines.length, root: root.toString("hex"), signedBy, findings: findings.size, problems };
  }

  // ---- internals ------------------------------------------------------------------------

  private load(): void {
    const path = join(this.dir, "entries.jsonl");
    if (!existsSync(path)) return;
    const raw = readFileSync(path, "utf8").replace(/\n$/, "");
    if (raw === "") return;
    for (const line of raw.split("\n")) {
      // Every line counts toward the tree even if it's corrupt — `verify()` is where a
      // corrupt line is reported; `open()` must not throw on a tampered file.
      this.lines.push(line);
      this.leaves.push(hashLeaf(Buffer.from(line, "utf8")));
      try {
        const env = envelopeSchema.parse(JSON.parse(line));
        const stmt = statementSchema.parse(JSON.parse(Buffer.from(env.payload, "base64").toString("utf8")));
        this.fold(stmt.predicate, this.lines.length - 1);
      } catch {
        /* reported by verify() */
      }
    }
  }

  private fold(ev: FindingEvent, index: number): void {
    this.indexByEvent.set(ev.eventId, index);
    const current = this.findings.get(ev.findingId) ?? null;
    this.findings.set(ev.findingId, applyEvent(current, ev));
    const evs = this.eventsByFinding.get(ev.findingId) ?? [];
    evs.push(ev);
    this.eventsByFinding.set(ev.findingId, evs);
  }

  private writeTiles(): void {
    for (const t of tiles(this.leaves)) {
      const rel = tilePath(t.level, t.index, t.hashes.length);
      const abs = join(this.dir, rel);
      const key = `${t.level}/${t.index}`;
      const prevPartial = this.partialTiles.get(key);
      if (existsSync(abs) && prevPartial === undefined) continue; // full tile already on disk
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, Buffer.concat(t.hashes));
      if (prevPartial && prevPartial !== rel) {
        try {
          unlinkSync(join(this.dir, prevPartial));
        } catch {
          /* already gone */
        }
      }
      if (t.hashes.length < 256) this.partialTiles.set(key, rel);
      else this.partialTiles.delete(key);
    }
  }
}

function loadKey(dir: string, opts: OpenOptions): SigningKey | null {
  if (opts.key) return opts.key;
  const seedB64 = opts.keySeedBase64 ?? process.env.EARTHDECK_LEDGER_KEY;
  if (seedB64) return keyFromSeed(Buffer.from(seedB64, "base64"));
  const keyPath = join(dir, "ledger.key");
  if (existsSync(keyPath)) return keyFromSeed(Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64"));
  if (opts.createKey === false) return null;
  const { key, seed } = generateKey();
  writeFileSync(keyPath, `${seed.toString("base64")}\n`, { mode: 0o600 });
  writeFileSync(join(dir, "ledger.pub"), `${key.publicRaw.toString("base64")}\n`);
  return key;
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
