// The real, SDK-backed RunnerDeps. The AWS SDK v3 is NOT bundled: the Lambda Node.js 22
// runtime ships it (/var/runtime/node_modules), so the @aws-sdk/* packages are exact-pinned
// devDependencies used for typechecking only and are excluded from the zip.
//
// Runtime-provided modules are loaded lazily: native ESM `import()` first, then a CommonJS
// `require` fallback (which honours NODE_PATH, where Lambda puts the runtime's SDK) — so
// this works whichever way the runtime exposes it.

import { createRequire } from "node:module";
import type * as S3 from "@aws-sdk/client-s3";
import type * as SSM from "@aws-sdk/client-ssm";
import type * as CloudFront from "@aws-sdk/client-cloudfront";
import type * as CloudWatch from "@aws-sdk/client-cloudwatch";
import type { ObjectStore, PutOptions } from "./core.js";

async function load<T>(name: string): Promise<T> {
  try {
    return (await import(name)) as T;
  } catch {
    return createRequire(import.meta.url)(name) as T;
  }
}

export async function s3Store(region: string): Promise<ObjectStore> {
  const m = await load<typeof S3>("@aws-sdk/client-s3");
  const s3 = new m.S3Client({ region });
  return {
    async list(bucket, prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const r = await s3.send(new m.ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of r.Contents ?? []) if (o.Key) keys.push(o.Key);
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
    async get(bucket, key) {
      const r = await s3.send(new m.GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!r.Body) return Buffer.alloc(0);
      return Buffer.from(await r.Body.transformToByteArray());
    },
    async put(bucket, key, body, opts: PutOptions = {}) {
      await s3.send(new m.PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: opts.contentType, CacheControl: opts.cacheControl }));
    },
    async remove(bucket, keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        const chunk = keys.slice(i, i + 1000);
        await s3.send(new m.DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true } }));
      }
    },
  };
}

/** Every parameter under `prefix`, decrypted. */
export async function readParameters(region: string, prefix: string): Promise<{ name: string; value: string }[]> {
  const m = await load<typeof SSM>("@aws-sdk/client-ssm");
  const ssm = new m.SSMClient({ region });
  const out: { name: string; value: string }[] = [];
  let token: string | undefined;
  do {
    const r = await ssm.send(new m.GetParametersByPathCommand({ Path: prefix, Recursive: true, WithDecryption: true, NextToken: token }));
    for (const p of r.Parameters ?? []) if (p.Name && p.Value !== undefined) out.push({ name: p.Name, value: p.Value });
    token = r.NextToken;
  } while (token);
  return out;
}

export async function cloudFrontInvalidator(region: string): Promise<(distributionId: string) => Promise<void>> {
  const m = await load<typeof CloudFront>("@aws-sdk/client-cloudfront");
  const cf = new m.CloudFrontClient({ region });
  return async (distributionId) => {
    await cf.send(
      new m.CreateInvalidationCommand({
        DistributionId: distributionId,
        InvalidationBatch: { CallerReference: `earthdeck-${Date.now()}`, Paths: { Quantity: 1, Items: ["/*"] } },
      }),
    );
  };
}

export async function jobSuccessMetric(region: string): Promise<() => Promise<void>> {
  const m = await load<typeof CloudWatch>("@aws-sdk/client-cloudwatch");
  const cw = new m.CloudWatchClient({ region });
  return async () => {
    await cw.send(new m.PutMetricDataCommand({ Namespace: "earthdeck", MetricData: [{ MetricName: "JobSuccess", Value: 1, Unit: "Count" }] }));
  };
}
