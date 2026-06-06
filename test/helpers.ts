// Test helpers: a no-network `fetch` mock built on real `Response` objects, so client code
// sees genuine `.ok` / `.status` / `.text()` / `.json()` / `.headers` / `.arrayBuffer()`
// behavior. Nothing here ever touches the network — these tests run fully offline.

export interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface FetchMock {
  calls: CapturedCall[];
  restore: () => void;
}

type Responder = (url: string, call: CapturedCall) => Response | Promise<Response>;

/**
 * Swap `globalThis.fetch` for a mock that records every call and returns whatever `responder`
 * produces. Call `.restore()` (e.g. in `t.after`) to put the real fetch back.
 */
export function mockFetch(responder: Responder): FetchMock {
  const calls: CapturedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h && typeof h === "object" && !Array.isArray(h)) {
      for (const [k, v] of Object.entries(h as Record<string, string>)) headers[k.toLowerCase()] = String(v);
    }
    const body = typeof init?.body === "string" ? init.body : init?.body == null ? null : String(init.body);
    const call: CapturedCall = { url, method: (init?.method ?? "GET").toUpperCase(), headers, body };
    calls.push(call);
    return responder(url, call);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

export function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/plain" }, ...init });
}

/** A binary (image) response. `body` is a Buffer/Uint8Array. */
export function binaryResponse(body: Uint8Array, mime = "image/jpeg", init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": mime }, ...init });
}
