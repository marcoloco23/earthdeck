// The public site's only script. Pages arrive fully server-rendered by `earthdeck watch
// export`; this adds what needs a browser: copy buttons, relative times, the "include
// unpublished" switch, the world-pulse card (the dashboard's own renderer), and — on case
// pages — the proof check against the signed checkpoint, done with WebCrypto.

import "../styles.css";
import "./site.css";
import { apiPaths } from "../api";
import { renderCard } from "../cards";
import { bytesToHex, leafTile, parseCheckpoint, verifyCheckpointSignature, verifyInclusion } from "../proof";
import { ago } from "../ui";
import type { Card } from "../types";

const page = document.body.dataset.page ?? "";
const DEPTH: Record<string, number> = { landing: 0, trust: 0, watch: 1, case: 3 };
const prefix = "../".repeat(DEPTH[page] ?? 0);
const api = apiPaths("static", prefix);
const siteRoot = new URL(prefix || ".", location.href).href.replace(/\/+$/, "");

// ---- everywhere -------------------------------------------------------------------------------

for (const b of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
  b.hidden = false;
  let timer = 0;
  b.addEventListener("click", () => {
    void navigator.clipboard?.writeText(b.dataset.copy ?? "").then(
      () => {
        b.textContent = "Copied";
        b.classList.add("is-done");
        clearTimeout(timer);
        timer = window.setTimeout(() => {
          b.textContent = "Copy";
          b.classList.remove("is-done");
        }, 1400);
      },
      () => (b.textContent = "Copy failed"),
    );
  });
}

for (const t of document.querySelectorAll<HTMLTimeElement>("time.ago")) {
  t.title = t.dateTime;
  t.textContent = ago(t.dateTime);
}

// Exported without --base-url: point the commands at wherever this copy is served from.
for (const code of document.querySelectorAll<HTMLElement>("[data-base-cmd]")) {
  const text = (code.textContent ?? "").split("https://<this-site>").join(siteRoot);
  code.textContent = text;
  const btn = code.parentElement?.querySelector<HTMLButtonElement>("button[data-copy]");
  if (btn) btn.dataset.copy = text;
}

// ---- landing: world pulse ------------------------------------------------------------------------

if (page === "landing") {
  void fetch(api.pulse!)
    .then((r) => (r.ok ? (r.json() as Promise<{ generatedAt?: string; rows?: unknown[]; summary?: string; counts?: { improving: number; worsening: number } }>) : null))
    .then((p) => {
      if (!p || !Array.isArray(p.rows) || !p.rows.length) return;
      const card: Card = {
        id: "world-pulse",
        type: "worldpulse",
        ts: p.generatedAt ?? new Date().toISOString(),
        title: p.counts ? `${p.counts.improving} improving · ${p.counts.worsening} worsening` : "World pulse",
        payload: { rows: p.rows, summary: p.summary },
      };
      const node = renderCard(card, () => {});
      node.removeAttribute("tabindex");
      node.classList.add("card--static", "no-enter");
      document.getElementById("pulse")?.appendChild(node);
      const band = document.getElementById("pulse-band");
      if (band) band.hidden = false;
    })
    .catch(() => {});
}

// ---- cases index: the transparency switch ----------------------------------------------------------

if (page === "watch") {
  const toggle = document.querySelector<HTMLButtonElement>(".vis-toggle");
  const list = document.getElementById("case-list");
  const empty = document.querySelector<HTMLElement>(".only-public");
  if (toggle && list) {
    const set = (all: boolean) => {
      list.classList.toggle("list--public", !all);
      toggle.classList.toggle("is-on", all);
      toggle.setAttribute("aria-checked", String(all));
      if (empty) empty.hidden = all;
      const url = new URL(location.href);
      if (all) url.searchParams.set("all", "1");
      else url.searchParams.delete("all");
      history.replaceState(null, "", url);
    };
    toggle.hidden = false;
    toggle.addEventListener("click", () => set(toggle.getAttribute("aria-checked") !== "true"));
    if (new URLSearchParams(location.search).get("all") === "1") set(true);
  }
}

// ---- case page: check the proof in the browser -------------------------------------------------------

if (page === "case") void verifyCase();

async function verifyCase(): Promise<void> {
  const box = document.querySelector<HTMLElement>(".verify");
  if (!box?.dataset.leaf) return;
  const d = box.dataset;
  const inc = { leaf: d.leaf!, index: Number(d.index), size: Number(d.size), root: d.root ?? "", proof: d.proof ? d.proof.split(",") : [] };
  box.querySelector<HTMLElement>(".verify-live")!.hidden = false;
  box.querySelector<HTMLElement>(".checks--verify")!.hidden = false;
  const set = (i: number, state: boolean | null, note?: string) => {
    const li = box.querySelector<HTMLElement>(`[data-check="${i}"]`);
    if (!li) return;
    li.className = `check ${state === true ? "check--ok" : state === false ? "check--bad" : "check--no"}`;
    li.querySelector(".check-mark")!.textContent = state === true ? "✓" : state === false ? "✗" : "?";
    const sr = document.createElement("span");
    sr.className = "sr-only";
    sr.textContent = state === true ? " — passed" : state === false ? " — FAILED" : " — could not check";
    li.lastElementChild?.appendChild(sr);
    if (note) {
      const n = document.createElement("span");
      n.className = "check-note";
      n.textContent = note;
      li.appendChild(n);
    }
  };
  const text = (url: string) =>
    fetch(url, { cache: "no-cache" })
      .then((r) => (r.ok ? r.text() : null))
      .catch(() => null);

  const [cpText, pub] = await Promise.all([text(api.checkpoint), text(api.pub)]);
  const cp = cpText ? parseCheckpoint(cpText) : null;
  if (!cp) {
    for (let i = 0; i < 3; i++) set(i, null, i === 0 ? "checkpoint unavailable" : undefined);
    return;
  }
  try {
    const ok = pub ? await verifyCheckpointSignature(cp, pub) : null;
    set(0, ok, ok === null ? (pub ? "this browser has no Ed25519 in WebCrypto — use the CLI" : "public key unavailable") : undefined);
  } catch {
    set(0, false);
  }
  // A sweep may have appended since this page was rendered: the proof is for the tree it was
  // rendered against. Tiles and root must then come from that same tree size.
  const sameTree = inc.size === cp.size && inc.root === cp.rootHex;
  try {
    if (!sameTree) set(1, null, `the log has grown to ${cp.size} entries since this page was built — re-export to refresh`);
    else {
      const t = leafTile(inc.index, cp.size);
      const res = await fetch(api.tile(t.path), { cache: "no-cache" });
      if (!res.ok) set(1, null, "tile not published");
      else {
        const bytes = new Uint8Array(await res.arrayBuffer());
        set(1, bytesToHex(bytes.slice(t.offset, t.offset + 32)) === inc.leaf, `${t.path}, entry ${t.offset / 32}`);
      }
    }
  } catch {
    set(1, null, "tile unavailable");
  }
  try {
    set(2, sameTree ? await verifyInclusion(inc.leaf, inc.index, inc.size, inc.proof, cp.rootHex) : null, sameTree ? undefined : "proof is for an earlier tree size");
  } catch {
    set(2, false);
  }
}
