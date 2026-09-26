// The Watch tab: the findings ledger as a case list + case page, straight from
// /api/ledger. Everything is built with DOM nodes / textContent (no innerHTML from data)
// because ledger content is, by design, what the outside world will eventually write.

import type { BBox } from "./types";

export interface Evidence {
  id: string;
  kind: string;
  source: string;
  datetime: string;
  href?: string;
  method: { name: string; version: string; params?: Record<string, unknown> };
  summary?: string;
  values?: Record<string, number>;
}
export interface Finding {
  findingId: string;
  status: string;
  tier: number;
  rule: { name: string; version: string };
  title: string;
  summary: string;
  geometry: { type: string; coordinates: unknown };
  bbox: BBox;
  aoi?: { id: string; name?: string; tags?: string[] };
  observedAt: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  confirmed: null | { at: string; independence: string; signal: Evidence };
  evidence: Evidence[];
  attribution: null | { subject: { kind: string; name: string }; party?: { name: string; registry: { name: string; url: string } }; reviewers: string[] };
  narration: null | { text: string; model: { id: string }; reviewedBy?: string };
  reviews: { actor: string; decision: string; tier: number; note?: string; at: string }[];
  notifications: { to: { kind: string; name: string; channel?: string }; publicAt: string; at: string }[];
  replies: { from: string; text: string; receivedAt: string }[];
  retracted: null | { at: string; reason: string };
  history: { at: string; kind: string; status: string; actor: string }[];
  eventCount: number;
  lastEventHash: string;
}

interface LedgerResponse {
  size: number;
  root: string | null;
  findings: Finding[];
}

const PUBLIC = new Set(["published", "notified", "replied", "no_response", "resolved", "ignored", "retracted"]);

export function initWatch(root: HTMLElement, onFocus: (f: Finding) => void): { refresh: () => Promise<void> } {
  const head = el("div", "watch-head");
  const counts = el("span", "watch-counts", "loading…");
  const verify = el("span", "watch-verify", "");
  head.append(counts, verify);
  const list = el("div", "watch-list");
  const detail = el("div", "watch-detail");
  detail.hidden = true;
  root.append(head, list, detail);

  let findings: Finding[] = [];

  async function refresh(): Promise<void> {
    try {
      const res = await fetch("/api/ledger");
      const data = (await res.json()) as LedgerResponse;
      findings = data.findings;
      const pub = findings.filter((f) => PUBLIC.has(f.status)).length;
      counts.textContent = `${findings.length} cases · ${pub} public · ${data.size} ledger entries`;
      verify.textContent = data.root ? `root ${data.root.slice(0, 12)}…` : "";
      verify.title = data.root ? `Merkle root ${data.root}\nVerify: earthdeck ledger verify` : "";
      renderList();
    } catch {
      counts.textContent = "ledger unavailable";
    }
  }

  function renderList(): void {
    list.replaceChildren();
    if (findings.length === 0) {
      list.appendChild(el("div", "watch-empty", "No cases yet. Run `earthdeck ledger seed` for demo cases, or `earthdeck watch --once` (M2)."));
      return;
    }
    for (const f of findings) {
      const row = el("button", "watch-row") as HTMLButtonElement;
      row.type = "button";
      row.append(statusBadge(f.status), el("span", "watch-tier", `T${f.tier}`), el("span", "watch-title", f.title));
      row.appendChild(el("span", "watch-meta", `${f.rule.name}@${f.rule.version} · ${f.evidence.length} evidence · ${dateOf(f.updatedAt)}`));
      row.addEventListener("click", () => {
        showDetail(f);
        onFocus(f);
      });
      list.appendChild(row);
    }
  }

  function showDetail(f: Finding): void {
    detail.replaceChildren();
    detail.hidden = false;
    list.hidden = true;
    const back = el("button", "watch-back", "← all cases") as HTMLButtonElement;
    back.type = "button";
    back.addEventListener("click", () => {
      detail.hidden = true;
      list.hidden = false;
    });
    detail.appendChild(back);

    const h = el("div", "watch-detail-head");
    h.append(statusBadge(f.status), el("span", "watch-tier", `tier ${f.tier}`), el("h2", "watch-h2", f.title));
    detail.appendChild(h);
    detail.appendChild(el("p", "watch-summary", f.summary));
    if (f.retracted) detail.appendChild(el("p", "watch-retracted", `RETRACTED ${dateOf(f.retracted.at)}: ${f.retracted.reason}`));

    const facts = el("dl", "watch-facts");
    fact(facts, "Rule", `${f.rule.name} v${f.rule.version}`);
    fact(facts, "Observed", dateOf(f.observedAt));
    fact(facts, "Opened by", f.createdBy);
    if (f.aoi) fact(facts, "Area", `${f.aoi.name ?? f.aoi.id}${f.aoi.tags?.length ? ` (${f.aoi.tags.join(", ")})` : ""}`);
    fact(facts, "Confirmed", f.confirmed ? `yes — independent ${f.confirmed.independence} signal, ${dateOf(f.confirmed.at)}` : "no — single signal (candidate)");
    if (f.attribution) {
      fact(facts, "Subject", `${f.attribution.subject.kind}: ${f.attribution.subject.name}`);
      if (f.attribution.party) fact(facts, "Party", `${f.attribution.party.name} (via ${f.attribution.party.registry.name}; ${f.attribution.reviewers.length} reviewers)`);
    }
    detail.appendChild(facts);

    detail.appendChild(section("Evidence", f.evidence.concat(f.confirmed ? [f.confirmed.signal] : []).map(evidenceNode)));

    if (f.narration) {
      const n = el("div", "watch-narration");
      n.appendChild(el("p", "", f.narration.text));
      n.appendChild(el("div", "watch-disclosure", `AI-drafted (${f.narration.model.id})${f.narration.reviewedBy ? `, reviewed by ${f.narration.reviewedBy}` : ", not yet human-reviewed"}`));
      detail.appendChild(section("Explanation", [n]));
    }

    if (f.notifications.length || f.replies.length) {
      const items = f.notifications.map((n) => el("li", "", `${dateOf(n.at)} notified ${n.to.kind} ${n.to.name} — public from ${dateOf(n.publicAt)}`));
      items.push(...f.replies.map((r) => el("li", "watch-reply", `${dateOf(r.receivedAt)} reply from ${r.from}: “${r.text}”`)));
      if (f.notifications.length && !f.replies.length) items.push(el("li", "watch-noreply", "No response recorded yet."));
      const ul = el("ul", "watch-timeline");
      ul.append(...items);
      detail.appendChild(section("Response", [ul]));
    }

    const tl = el("ul", "watch-timeline");
    for (const h of f.history) tl.appendChild(el("li", "", `${dateOf(h.at)} · ${h.kind} → ${h.status} · ${h.actor}`));
    detail.appendChild(section("Timeline", [tl]));

    const v = el("div", "watch-verifybox");
    v.appendChild(el("div", "", `${f.eventCount} signed events · last event hash ${f.lastEventHash.slice(0, 16)}…`));
    const a = document.createElement("a");
    a.href = `/api/ledger/${encodeURIComponent(f.findingId)}`;
    a.target = "_blank";
    a.textContent = "events + inclusion proof (JSON)";
    const c = document.createElement("a");
    c.href = "/ledger/checkpoint";
    c.target = "_blank";
    c.textContent = "signed checkpoint";
    v.append(a, document.createTextNode(" · "), c);
    detail.appendChild(section("Verify", [v]));
  }

  void refresh();
  return { refresh };
}

function evidenceNode(e: Evidence): HTMLElement {
  const d = el("div", "watch-evidence");
  d.appendChild(el("div", "watch-evidence-id", `${e.kind} · ${e.source}`));
  d.appendChild(el("div", "watch-evidence-meta", `${e.id} · ${dateOf(e.datetime)} · ${e.method.name} v${e.method.version}`));
  if (e.summary) d.appendChild(el("div", "watch-evidence-sum", e.summary));
  if (e.values) d.appendChild(el("div", "watch-evidence-vals", Object.entries(e.values).map(([k, v]) => `${k}=${v}`).join("  ")));
  if (e.href) {
    const a = document.createElement("a");
    a.href = e.href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "source ↗";
    d.appendChild(a);
  }
  return d;
}

function section(title: string, children: HTMLElement[]): HTMLElement {
  const s = el("section", "watch-section");
  s.appendChild(el("h3", "watch-h3", title));
  s.append(...children);
  return s;
}

function fact(dl: HTMLElement, k: string, v: string): void {
  dl.append(el("dt", "", k), el("dd", "", v));
}

export function statusBadge(status: string): HTMLElement {
  const safe = /^[a-z_]+$/.test(status) ? status : "unknown";
  return el("span", `status-badge status--${safe}`, status.replace("_", " "));
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function dateOf(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}
