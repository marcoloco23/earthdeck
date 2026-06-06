import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import { dashboardPort, SERVER_NAME, SERVER_VERSION } from "../config.js";
import type { Card, IngestPayload } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(__dirname, "..", "web"); // dist/web after build

const MAX_CARDS = 200;
const MAX_IMAGES = 200;

const CARD_TYPES = new Set<string>(["imagery", "index", "fires", "events", "compare", "search"]);
const ALLOWED_IMAGE_MIME = new Set<string>(["image/jpeg", "image/png"]);

/**
 * Validate an untrusted /ingest body into an IngestPayload. Throws on anything malformed.
 * This is the trust boundary: `type` and `image.mimeType` are allow-listed so a crafted
 * POST can't inject unknown card types (which the browser turns into CSS classes) or get
 * an arbitrary Content-Type served back from /img.
 */
export function validateIngest(obj: unknown): IngestPayload {
  if (typeof obj !== "object" || obj === null) throw new Error("body must be an object");
  const o = obj as Record<string, unknown>;
  // Constrain id to a safe charset: it becomes an /img/{id} key and is embedded in the UI.
  if (typeof o.id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(o.id)) throw new Error("invalid id");
  if (typeof o.type !== "string" || !CARD_TYPES.has(o.type)) throw new Error("invalid type");
  if (typeof o.ts !== "string") throw new Error("ts required");
  if (typeof o.title !== "string") throw new Error("title required");
  if (typeof o.payload !== "object" || o.payload === null) throw new Error("payload required");
  const out: IngestPayload = {
    id: o.id,
    type: o.type as IngestPayload["type"],
    ts: o.ts,
    title: o.title,
    payload: o.payload as Record<string, unknown>,
  };
  if (o.bbox !== undefined) {
    if (!Array.isArray(o.bbox) || o.bbox.length !== 4 || !o.bbox.every((n) => typeof n === "number")) {
      throw new Error("bbox must be 4 numbers");
    }
    out.bbox = o.bbox as IngestPayload["bbox"];
  }
  if (o.image !== undefined) out.image = validateImage(o.image);
  if (o.images !== undefined) {
    if (!Array.isArray(o.images) || o.images.length > 4) throw new Error("images must be an array (max 4)");
    out.images = o.images.map(validateImage);
  }
  return out;
}

function validateImage(v: unknown): { mimeType: string; dataBase64: string } {
  const img = v as Record<string, unknown>;
  if (typeof img.mimeType !== "string" || !ALLOWED_IMAGE_MIME.has(img.mimeType)) {
    throw new Error("image.mimeType must be image/jpeg or image/png");
  }
  if (typeof img.dataBase64 !== "string") throw new Error("image.dataBase64 required");
  return { mimeType: img.mimeType, dataBase64: img.dataBase64 };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

interface StoredImage {
  buf: Buffer;
  mimeType: string;
}

/** In-memory dashboard state — a bounded card feed + image cache + SSE clients. */
class DashboardState {
  cards: Card[] = [];
  images = new Map<string, StoredImage>();
  clients = new Set<ServerResponse>();

  addCard(payload: IngestPayload): Card {
    const { image, images, ...rest } = payload;
    const card: Card = { ...rest };
    if (image?.dataBase64) {
      this.images.set(card.id, {
        buf: Buffer.from(image.dataBase64, "base64"),
        mimeType: image.mimeType,
      });
      card.imageUrl = `/img/${card.id}`;
    }
    if (images && images.length > 0) {
      card.imageUrls = images.map((im, i) => {
        const key = `${card.id}::${i}`;
        this.images.set(key, { buf: Buffer.from(im.dataBase64, "base64"), mimeType: im.mimeType });
        return `/img/${key}`;
      });
    }
    if (image?.dataBase64 || (images && images.length > 0)) this.evictImages();
    this.cards.push(card);
    if (this.cards.length > MAX_CARDS) this.cards.shift();
    this.broadcast(card);
    return card;
  }

  private evictImages(): void {
    while (this.images.size > MAX_IMAGES) {
      const oldest = this.images.keys().next().value;
      if (oldest === undefined) break;
      this.images.delete(oldest);
    }
  }

  broadcast(card: Card): void {
    const line = `data: ${JSON.stringify(card)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(line);
      } catch {
        this.clients.delete(res); // drop a dead client instead of breaking the loop
      }
    }
  }
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

async function readBody(req: IncomingMessage, limitBytes = 32 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  // Map "/" → index.html; strip query; prevent path traversal.
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  } catch {
    send(res, 400, "text/plain", "bad request");
    return;
  }
  const clean = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  let rel = clean === "/" || clean === "" ? "index.html" : clean.replace(/^\/+/, "");
  let filePath = join(WEB_ROOT, rel);

  if (!filePath.startsWith(WEB_ROOT)) {
    send(res, 403, "text/plain", "forbidden");
    return;
  }

  // SPA fallback: unknown path without a file extension → index.html.
  if (!existsSync(filePath)) {
    if (extname(rel) === "" && existsSync(join(WEB_ROOT, "index.html"))) {
      filePath = join(WEB_ROOT, "index.html");
      rel = "index.html";
    } else if (rel === "index.html") {
      send(res, 200, "text/html; charset=utf-8", FALLBACK_HTML);
      return;
    } else {
      send(res, 404, "text/plain", "not found");
      return;
    }
  }

  try {
    const data = await readFile(filePath);
    send(res, 200, MIME[extname(filePath)] ?? "application/octet-stream", data);
  } catch {
    send(res, 500, "text/plain", "read error");
  }
}

export function startDashboard(port = dashboardPort()): void {
  const state = new DashboardState();

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // CORS for local tooling.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url === "/healthz") {
      send(res, 200, "application/json", JSON.stringify({ ok: true, name: SERVER_NAME, version: SERVER_VERSION }));
      return;
    }

    if (url === "/api/state") {
      send(res, 200, "application/json", JSON.stringify({ cards: state.cards }));
      return;
    }

    if (url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      res.write(`retry: 3000\n\n`);
      for (const card of state.cards) res.write(`data: ${JSON.stringify(card)}\n\n`);
      const drop = () => {
        clearInterval(ping);
        state.clients.delete(res);
      };
      const ping = setInterval(() => {
        try {
          res.write(`: ping\n\n`);
        } catch {
          drop();
        }
      }, 25_000);
      state.clients.add(res);
      req.on("close", drop);
      res.on("error", drop);
      return;
    }

    if (url.startsWith("/img/")) {
      let id: string;
      try {
        id = decodeURIComponent(url.slice("/img/".length).split("?")[0] ?? "");
      } catch {
        send(res, 400, "text/plain", "bad request");
        return;
      }
      const img = state.images.get(id);
      if (!img) {
        send(res, 404, "text/plain", "no such image");
        return;
      }
      res.writeHead(200, { "content-type": img.mimeType, "cache-control": "private, max-age=3600" });
      res.end(img.buf);
      return;
    }

    if (url === "/ingest" && method === "POST") {
      readBody(req)
        .then((body) => {
          const payload = validateIngest(JSON.parse(body));
          const card = state.addCard(payload);
          send(res, 200, "application/json", JSON.stringify({ ok: true, id: card.id }));
        })
        .catch((err: unknown) => {
          send(res, 400, "application/json", JSON.stringify({ ok: false, error: String(err) }));
        });
      return;
    }

    if (method === "GET") {
      serveStatic(res, url).catch(() => {
        try {
          send(res, 500, "text/plain", "error");
        } catch {
          /* response already gone */
        }
      });
      return;
    }

    send(res, 404, "text/plain", "not found");
  });

  // Bind to loopback only: the dashboard is unauthenticated with permissive CORS, so it
  // must not be reachable from other machines on the network.
  server.listen(port, "127.0.0.1", () => {
    process.stderr.write(
      `${SERVER_NAME} dashboard running at http://localhost:${port}  (open it in your browser)\n`,
    );
    if (!existsSync(join(WEB_ROOT, "index.html"))) {
      process.stderr.write(
        `  note: built UI not found at ${WEB_ROOT} — serving fallback shell. Run \`pnpm build\` for the full dashboard.\n`,
      );
    }
  });

  // Last-resort safety net: a single malformed request must never take the server down.
  process.on("uncaughtException", (err) => process.stderr.write(`[dashboard] uncaughtException: ${err}\n`));
  process.on("unhandledRejection", (err) => process.stderr.write(`[dashboard] unhandledRejection: ${err}\n`));
}

/** Minimal shell served when the Vite build hasn't been produced yet. */
const FALLBACK_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>overview-mcp</title>
<style>body{font:14px ui-monospace,monospace;background:#0b0f17;color:#cbd5e1;margin:0;padding:2rem}
#feed div{border:1px solid #1e293b;border-radius:8px;padding:.6rem .8rem;margin:.4rem 0}
h1{color:#38bdf8;font-size:1rem}</style></head><body>
<h1>overview-mcp dashboard (fallback shell)</h1>
<p>Run <code>pnpm build</code> for the full map UI. Live cards stream below.</p>
<div id="feed"></div>
<script>const f=document.getElementById('feed');const es=new EventSource('/events');
es.onmessage=e=>{const c=JSON.parse(e.data);const d=document.createElement('div');
d.textContent='['+c.type+'] '+c.title+(c.imageUrl?'  '+c.imageUrl:'');f.prepend(d);};</script>
</body></html>`;
