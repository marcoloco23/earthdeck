// RFC 8785 — JSON Canonicalization Scheme (JCS). Vendored (~60 lines) rather than pulled
// from npm so the ledger's trust root has zero dependencies: the bytes we hash and sign
// are produced here and nowhere else. Verified against the RFC's own test vectors in
// test/jcs.test.ts, so a Node upgrade can't silently change number serialization.
//
// Rules (RFC 8785 §3.2): object keys sorted by UTF-16 code units; numbers serialized per
// ECMAScript Number::toString (which JSON.stringify already implements); strings escaped
// per JSON.stringify; no whitespace; no NaN/Infinity; undefined/functions are rejected in
// objects (they'd be silently dropped by JSON.stringify — we'd rather fail loudly).

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/** Canonicalize a JSON-compatible value to its RFC 8785 string form. */
export function canonicalize(value: unknown): string {
  const out: string[] = [];
  write(value, out);
  return out.join("");
}

/** UTF-8 bytes of the canonical form — what gets hashed and signed. */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), "utf8");
}

function write(value: unknown, out: string[]): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`JCS: non-finite number ${value}`);
      // ES Number::toString — identical to JSON.stringify for finite numbers, and -0 → "0".
      out.push(JSON.stringify(value));
      return;
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "object":
      break;
    default:
      throw new TypeError(`JCS: unsupported type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    out.push("[");
    value.forEach((v, i) => {
      if (i > 0) out.push(",");
      // JSON.stringify turns undefined array items into null; JCS input shouldn't have them.
      if (v === undefined) throw new TypeError("JCS: undefined in array");
      write(v, out);
    });
    out.push("]");
    return;
  }
  const obj = value as Record<string, unknown>;
  // Sort keys by UTF-16 code units — JS string comparison does exactly this (RFC 8785 §3.2.3).
  const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  out.push("{");
  let first = true;
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) throw new TypeError(`JCS: undefined value at key ${JSON.stringify(k)}`);
    if (!first) out.push(",");
    first = false;
    out.push(JSON.stringify(k), ":");
    write(v, out);
  }
  out.push("}");
}
