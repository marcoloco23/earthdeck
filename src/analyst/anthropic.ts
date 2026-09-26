// Minimal Claude Messages API client over native `fetch` (no SDK dependency — pinned-deps
// discipline). One call = one JSON object constrained by a JSON schema via structured
// outputs (`output_config.format`), with usage + a cost estimate so every call can be
// journaled. Shapes follow the claude-api skill (cached 2026-06-24); see README "Analyst".

import { createHash } from "node:crypto";
import { OverviewError } from "../errors.js";

export const ANTHROPIC_VERSION = "2023-06-01";
/** Server-side refusal fallback (`fallbacks: "default"`), recommended for Opus 5 / Fable. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const TIMEOUT_MS = 5 * 60_000;

/** $ per 1M tokens [input, output] — first-party list prices (claude-api skill, 2026-06-24). */
const PRICES: Record<string, [number, number]> = {
  "claude-fable-5-1": [10, 50],
  "claude-fable-5": [10, 50],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-sonnet-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface JsonCallResult {
  /** Parsed JSON from the final text block (not yet validated — callers zod-check it). */
  data: unknown;
  /** The raw text the model returned (for retries that quote it back). */
  text: string;
  /** The model that actually served the request (may differ after a refusal fallback). */
  model: string;
  usage: Usage;
  costUsd: number | null;
  ms: number;
  /** SHA-256 of the exact request body — the `promptSha256` of a narration. */
  requestSha256: string;
  /** SHA-256 of the raw response body — the `transcriptSha256`. */
  responseSha256: string;
}

export interface JsonCallOptions {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export function costUsd(model: string, u: Usage): number | null {
  const p = PRICES[model];
  if (!p) return null;
  const input = u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1;
  return (input * p[0] + u.output_tokens * p[1]) / 1_000_000;
}

function wantsFallback(model: string): boolean {
  return model.startsWith("claude-opus-5") || model.startsWith("claude-fable-5");
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function callJson(o: JsonCallOptions): Promise<JsonCallResult> {
  const base = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");
  const fallback = wantsFallback(o.model);
  const body = JSON.stringify({
    model: o.model,
    max_tokens: o.maxTokens ?? 16_000,
    system: o.system,
    messages: [{ role: "user", content: o.user }],
    output_config: { effort: o.effort ?? "high", format: { type: "json_schema", schema: o.schema } },
    ...(fallback ? { fallbacks: "default" } : {}),
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": o.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  };
  if (fallback) headers["anthropic-beta"] = FALLBACK_BETA;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  let raw: string;
  let status: number;
  try {
    const res = await fetch(`${base}/v1/messages`, { method: "POST", headers, body, signal: controller.signal });
    status = res.status;
    raw = await res.text();
  } catch (err) {
    throw new OverviewError(`Anthropic API unreachable: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
  let json: MessagesResponse;
  try {
    json = JSON.parse(raw) as MessagesResponse;
  } catch {
    throw new OverviewError(`Anthropic API returned non-JSON (HTTP ${status})`, status, raw.slice(0, 500));
  }
  if (status < 200 || status >= 300 || json.type === "error") {
    const msg = json.error?.message ?? `HTTP ${status}`;
    throw new OverviewError(`Anthropic API ${status} (${json.error?.type ?? "error"}): ${msg}`, status, json);
  }
  if (json.stop_reason === "refusal") {
    throw new OverviewError(`model refused (${json.stop_details?.category ?? "no category"})`, status, json.stop_details);
  }
  if (json.stop_reason === "max_tokens") throw new OverviewError("model hit max_tokens before finishing its JSON", status);
  const texts = (json.content ?? []).filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string");
  const text = texts[texts.length - 1]?.text ?? "";
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new OverviewError("model returned no parseable JSON", status, text.slice(0, 500));
  }
  const model = json.model ?? o.model;
  const usage = json.usage ?? { input_tokens: 0, output_tokens: 0 };
  return { data, text, model, usage, costUsd: costUsd(model, usage), ms: Date.now() - t0, requestSha256: sha256(body), responseSha256: sha256(raw) };
}

interface MessagesResponse {
  type?: string;
  model?: string;
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  stop_details?: { category?: string | null } | null;
  usage?: Usage;
  error?: { type?: string; message?: string };
}
