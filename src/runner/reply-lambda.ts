// AWS Lambda entry for the public reply wall (handler `dist/runner/reply-lambda.handler`,
// same zip as the runner). Invoked through a Lambda Function URL (auth NONE; CORS for the
// site origin only, set on the URL in infra/earthdeck.yaml). The logic is in
// src/replies/intake.ts; this file only adapts the Function URL event and wires S3 + SSM.
//
// The raw source IP is read here, hashed with the salt inside handleReply and dropped: it is
// never logged, stored or returned.

import { handleReply, parseCaseIndex, CASE_INDEX_KEY } from "../replies/intake.js";
import { readParameter, s3KeyValue } from "./aws.js";

interface UrlEvent {
  rawPath?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string; sourceIp?: string } };
}

const INDEX_TTL_MS = 5 * 60_000;
let salt: string | null = null;
let index: { at: number; ids: Set<string> } | null = null;

export async function handler(event: UrlEvent): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  const region = process.env.AWS_REGION ?? "us-east-1";
  const bucket = process.env.EARTHDECK_STATE_BUCKET ?? "";
  const saltName = process.env.EARTHDECK_REPLY_SALT_PARAM ?? "/earthdeck/REPLY_SALT";
  const store = await s3KeyValue(region, bucket);
  const raw = event.body ?? "";
  const res = await handleReply(
    {
      method: event.requestContext?.http?.method ?? "GET",
      path: event.rawPath ?? "/",
      body: event.isBase64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw,
      ip: event.requestContext?.http?.sourceIp ?? "",
    },
    {
      store,
      salt: async () => (salt ??= await readParameter(region, saltName)),
      caseIds: async () => {
        if (index && Date.now() - index.at < INDEX_TTL_MS) return index.ids;
        const buf = await store.get(CASE_INDEX_KEY);
        if (!buf) throw new Error("case index missing");
        index = { at: Date.now(), ids: parseCaseIndex(buf) };
        return index.ids;
      },
      now: () => new Date(),
    },
  );
  // One line per request, without the IP or the text.
  console.log(JSON.stringify({ status: res.status, error: res.body.error ?? null }));
  return { statusCode: res.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(res.body) };
}
