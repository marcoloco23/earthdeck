// The Watch tab: the findings ledger as a case list + case page, straight from
// /api/ledger. Everything is built with DOM nodes / textContent (no innerHTML from data)
// because ledger content is, by design, what the outside world will eventually write.

import type { BBox } from "./types";
import { ago, copyButton, dateOf, el, safeStatus, statusBadge, tierBadge } from "./ui";

export { statusBadge };

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
  context?: {
    enso?: { phase: string; oni: number };
    events?: { id: string; title: string; category: string }[];
    baseline?: { metric: string; ringKm: number; aoiValue: number; regionalValue: number; ratio: number | null };
    notes?: string[];
  };
  blindSpots?: string[];
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

interface CaseResponse {
  inclusion: null | { index: number; leafHash: string; proof: string[]; size: number; root: string };
}

export interface LedgerSummary {
  cases: number;
  open: number;
  size: number;
  root: string | null;
  lastActivity: string | null;
  ok: boolean;
}

const PUBLIC = new Set(["published", "notified", "replied", "no_response", "resolved", "ignored", "retracted"]);
const OPEN = new Set(["candidate", "confirmed"]);
const CLOSED = new Set(["resolved", "ignored", "expired", "false_positive", "retracted"]);
/** The happy path a case walks; the stepper shows the path taken + what comes next. */
const MAIN_PATH = ["candidate", "confirmed", "published", "notified", "resolved"];

type Filter = "all" | "open" | "public" | "closed";
const FILTERS: Array<[Filter, string, (f: Finding) => boolean]> = [
  ["all", "All", () => true],
  ["open", "Open", (f) => OPEN.has(f.status)],
  ["public", "Public", (f) => PUBLIC.has(f.status)],
  ["closed", "Closed", (f) => CLOSED.has(f.status)],
];

export function initWatch(
  root: HTMLElement,
  onFocus: (f: Finding) => void,
  onData: (s: LedgerSummary) => void = () => {},
): { refresh: () => Promise<void> } {
  const head = el("div", "watch-head");
  const strip = el("div", "ledger-strip");
  const seg = el("div", "seg");
  seg.setAttribute("role", "toolbar");
  seg.setAttribute("aria-label", "Filter cases by status");
  head.append(strip, seg);
  const list = el("div", "watch-list");
  const detail = el("div", "watch-detail");
  detail.hidden = true;
  root.append(head, list, detail);

  let findings: Finding[] = [];
  let ledgerRoot: string | null = null;
  let ledgerSize = 0;
  let filter: Filter = "all";
  let loaded = false;
  let openId: string | null = null;
  let listScroll = 0;

  list.append(skeletonRow(), skeletonRow(), skeletonRow());

  async function refresh(): Promise<void> {
    try {
      const res = await fetch("/api/ledger");
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as LedgerResponse;
      findings = [...data.findings].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      ledgerRoot = data.root;
      ledgerSize = data.size;
      loaded = true;
      renderHead();
      renderList();
      if (openId && !detail.hidden) {
        const f = findings.find((x) => x.findingId === openId);
        if (f) updateDetailIfChanged(f);
      }
      onData({
        cases: findings.length,
        open: findings.filter((f) => OPEN.has(f.status)).length,
        size: data.size,
        root: data.root,
        lastActivity: findings[0]?.updatedAt ?? null,
        ok: true,
      });
    } catch {
      onData({ cases: 0, open: 0, size: 0, root: null, lastActivity: null, ok: false });
      if (loaded) return; // keep showing the last good list
      list.replaceChildren(errorState(() => void refresh()));
    }
  }

  function renderHead(): void {
    strip.replaceChildren();
    const pub = findings.filter((f) => PUBLIC.has(f.status)).length;
    const open = findings.filter((f) => OPEN.has(f.status)).length;
    const nums = el("div", "ledger-nums");
    for (const [v, k] of [
      [findings.length, "cases"],
      [open, "open"],
      [pub, "public"],
      [ledgerSize, "entries"],
    ] as const) {
      const n = el("span", "ledger-num");
      n.append(el("b", "", String(v)), document.createTextNode(` ${k}`));
      nums.appendChild(n);
    }
    strip.appendChild(nums);
    if (ledgerRoot) {
      const r = el("div", "ledger-root");
      const code = el("code", "hash", `${ledgerRoot.slice(0, 10)}…`);
      code.title = `Merkle root ${ledgerRoot}`;
      r.append(el("span", "ledger-root-k", "Root"), code, copyButton(ledgerRoot));
      strip.appendChild(r);
    }

    seg.replaceChildren();
    seg.hidden = findings.length === 0;
    for (const [key, label, pred] of FILTERS) {
      const b = el("button", `seg-btn${filter === key ? " is-on" : ""}`);
      b.type = "button";
      b.setAttribute("aria-pressed", String(filter === key));
      b.append(document.createTextNode(label), el("span", "seg-n", String(findings.filter(pred).length)));
      b.addEventListener("click", () => {
        filter = key;
        renderHead();
        renderList();
      });
      seg.appendChild(b);
    }
  }

  function renderList(): void {
    list.replaceChildren();
    if (findings.length === 0) {
      list.appendChild(emptyState());
      return;
    }
    const pred = FILTERS.find(([k]) => k === filter)![2];
    const shown = findings.filter(pred);
    if (shown.length === 0) {
      list.appendChild(el("p", "list-empty", `No ${filter} cases right now.`));
      return;
    }
    for (const f of shown) {
      const row = el("button", "case-row");
      row.type = "button";
      row.dataset.id = f.findingId;
      const top = el("div", "case-top");
      const when = el("span", "case-when", ago(f.updatedAt));
      when.title = `Updated ${f.updatedAt}`;
      top.append(statusBadge(f.status), tierBadge(f.tier), when);
      const meta = el("div", "case-meta", [f.aoi?.name ?? f.aoi?.id, `${f.rule.name}@${f.rule.version}`, `${f.evidence.length + (f.confirmed ? 1 : 0)} evidence`].filter(Boolean).join(" · "));
      row.append(top, el("div", "case-title", f.title), meta);
      row.addEventListener("click", () => {
        showDetail(f);
        onFocus(f);
      });
      list.appendChild(row);
    }
  }

  function back(): void {
    const id = openId;
    detail.hidden = true;
    list.hidden = false;
    head.hidden = false;
    openId = null;
    root.scrollTop = listScroll;
    if (id) list.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  }

  let shownJson = "";
  function updateDetailIfChanged(f: Finding): void {
    const j = JSON.stringify(f);
    if (j !== shownJson) showDetail(f, true);
  }

  function showDetail(f: Finding, quiet = false): void {
    if (!quiet) listScroll = root.scrollTop;
    shownJson = JSON.stringify(f);
    openId = f.findingId;
    const page = el("article", `case${quiet ? " no-enter" : ""}`);
    detail.replaceChildren(page);
    detail.hidden = false;
    list.hidden = true;
    head.hidden = true;
    if (!quiet) root.scrollTop = 0;

    const backBtn = el("button", "btn btn--ghost btn--back", "All cases");
    backBtn.type = "button";
    backBtn.addEventListener("click", back);
    page.appendChild(backBtn);

    const h = el("header", "case-head");
    const badges = el("div", "case-top");
    badges.append(statusBadge(f.status), tierBadge(f.tier));
    h.append(badges, el("h2", "case-h", f.title));
    const meta = [f.aoi ? f.aoi.name ?? f.aoi.id : null, `observed ${dateOf(f.observedAt)}`, `opened by ${f.createdBy}`].filter(Boolean).join(" · ");
    h.appendChild(el("p", "case-sub", meta));
    page.appendChild(h);
    page.appendChild(el("p", "case-summary", f.summary));
    if (f.retracted) page.appendChild(el("p", "banner banner--danger", `Retracted ${dateOf(f.retracted.at)} — ${f.retracted.reason}`));

    page.appendChild(stepper(f));

    const facts = el("dl", "kv kv--case");
    const fact = (k: string, v: string) => facts.append(el("dt", "", k), el("dd", "", v));
    fact("Rule", `${f.rule.name} v${f.rule.version}`);
    if (f.aoi?.tags?.length) fact("Tags", f.aoi.tags.join(", "));
    fact("Confirmed", f.confirmed ? `Yes — independent ${f.confirmed.independence} signal, ${dateOf(f.confirmed.at)}` : "Not yet — single signal");
    if (f.attribution) {
      fact("Subject", `${f.attribution.subject.kind}: ${f.attribution.subject.name}`);
      if (f.attribution.party) fact("Party", `${f.attribution.party.name} (via ${f.attribution.party.registry.name}; ${f.attribution.reviewers.length} reviewers)`);
    }
    page.appendChild(facts);

    const ev = f.evidence.map((e) => evidenceNode(e, false));
    if (f.confirmed) ev.push(evidenceNode(f.confirmed.signal, true));
    page.appendChild(section("Evidence", ev, String(ev.length)));

    const ctx = contextNodes(f);
    if (ctx.length) page.appendChild(section("Context", ctx));

    if (f.blindSpots?.length) {
      const ul = el("ul", "blind");
      for (const b of f.blindSpots) ul.appendChild(el("li", "", b));
      const s = section("Blind spots", [el("p", "section-lede", "What this rule cannot see — read the finding with these in mind."), ul], String(f.blindSpots.length));
      page.appendChild(s);
    }

    if (f.narration) {
      const n = el("div", "narration");
      n.appendChild(el("p", "", f.narration.text));
      n.appendChild(el("div", "disclosure", `AI-drafted (${f.narration.model.id})${f.narration.reviewedBy ? `, reviewed by ${f.narration.reviewedBy}` : " — not yet human-reviewed"}`));
      page.appendChild(section("Explanation", [n]));
    }

    if (f.notifications.length || f.replies.length) {
      const items = f.notifications.map((n) => timelineItem(n.at, `Notified ${n.to.kind} · ${n.to.name}`, `Public from ${dateOf(n.publicAt)}`));
      items.push(...f.replies.map((r) => timelineItem(r.receivedAt, `Reply from ${r.from}`, `“${r.text}”`, "tl--reply")));
      if (f.notifications.length && !f.replies.length) items.push(timelineItem(null, "No response recorded yet", "", "tl--waiting"));
      const ul = el("ol", "tl");
      ul.append(...items);
      page.appendChild(section("Right of reply", [ul]));
    }

    const tl = el("ol", "tl");
    for (const e of [...f.history].reverse()) tl.appendChild(timelineItem(e.at, `${e.kind.replace(/_/g, " ")} → ${e.status.replace(/_/g, " ")}`, e.actor));
    page.appendChild(section("History", [tl], String(f.history.length)));

    page.appendChild(section("Verify", [verifyBox(f)]));
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !detail.hidden && !root.hidden) back();
  });

  void refresh();
  return { refresh };
}

// ---- pieces ---------------------------------------------------------------------------

function stepper(f: Finding): HTMLElement {
  const taken: string[] = [];
  for (const h of f.history) if (taken[taken.length - 1] !== h.status) taken.push(h.status);
  if (taken[taken.length - 1] !== f.status) taken.push(f.status);
  let future: string[] = [];
  if (!CLOSED.has(f.status)) {
    const i = MAIN_PATH.indexOf(f.status);
    future = i >= 0 ? MAIN_PATH.slice(i + 1) : ["resolved"];
    // "notified" is optional after "published" — show it only when the rule path needs it.
    if (f.tier < 3) future = future.filter((s) => s !== "notified");
  }
  const ol = el("ol", "steps");
  ol.setAttribute("aria-label", "Case lifecycle");
  const add = (s: string, state: "done" | "current" | "future") => {
    const li = el("li", `step step--${state} status--${safeStatus(s)}`);
    li.append(el("span", "step-dot"), el("span", "step-label", s.replace(/_/g, " ")));
    if (state === "current") li.setAttribute("aria-current", "step");
    ol.appendChild(li);
  };
  taken.forEach((s, i) => add(s, i === taken.length - 1 ? "current" : "done"));
  for (const s of future) add(s, "future");
  return ol;
}

function contextNodes(f: Finding): HTMLElement[] {
  const out: HTMLElement[] = [];
  const b = f.context?.baseline;
  if (b && Number.isFinite(b.aoiValue) && Number.isFinite(b.regionalValue)) out.push(baselineStat(b));
  const chips = el("div", "chips");
  if (f.context?.enso) chips.appendChild(el("span", "chip", `ENSO ${f.context.enso.phase} · ONI ${f.context.enso.oni >= 0 ? "+" : ""}${f.context.enso.oni}`));
  for (const e of f.context?.events ?? []) chips.appendChild(el("span", "chip", `${e.category}: ${e.title}`));
  if (chips.childElementCount) out.push(chips);
  if (f.context?.notes?.length) {
    const ul = el("ul", "notes");
    for (const n of f.context.notes) ul.appendChild(el("li", "", n));
    out.push(ul);
  }
  return out;
}

/** AOI vs its neighbourhood ring: a ring diagram (inner disc = AOI, annulus = ring) + numbers. */
function baselineStat(b: NonNullable<NonNullable<Finding["context"]>["baseline"]>): HTMLElement {
  const box = el("div", "baseline");
  const max = Math.max(Math.abs(b.aoiValue), Math.abs(b.regionalValue)) || 1;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("class", "baseline-ring");
  svg.setAttribute("aria-hidden", "true");
  const ring = document.createElementNS(ns, "circle");
  ring.setAttribute("cx", "32");
  ring.setAttribute("cy", "32");
  ring.setAttribute("r", "24");
  ring.setAttribute("class", "ring-outer");
  ring.style.opacity = String(0.25 + 0.75 * (Math.abs(b.regionalValue) / max));
  const disc = document.createElementNS(ns, "circle");
  disc.setAttribute("cx", "32");
  disc.setAttribute("cy", "32");
  disc.setAttribute("r", "11");
  disc.setAttribute("class", "ring-inner");
  disc.style.opacity = String(0.25 + 0.75 * (Math.abs(b.aoiValue) / max));
  svg.append(ring, disc);

  const ratio = b.ratio ?? (b.regionalValue !== 0 ? b.aoiValue / b.regionalValue : null);
  const text = el("div", "baseline-text");
  const big = el("div", "baseline-ratio", ratio === null ? "—" : `${ratio.toFixed(2)}×`);
  text.append(big, el("div", "baseline-cap", `AOI vs its ${b.ringKm} km neighbourhood`));
  const rows = el("dl", "kv kv--tight");
  rows.append(el("dt", "", "AOI"), el("dd", "num", String(b.aoiValue)), el("dt", "", "Ring"), el("dd", "num", String(b.regionalValue)), el("dt", "", "Metric"), el("dd", "", b.metric));
  text.appendChild(rows);
  box.append(svg, text);
  return box;
}

function verifyBox(f: Finding): HTMLElement {
  const box = el("div", "verify");
  const body = el("div", "verify-body");
  body.append(skeletonLine("70%"), skeletonLine("55%"), skeletonLine("80%"));
  box.appendChild(body);

  const cmd = el("div", "cmdline");
  cmd.append(el("code", "cmd", "earthdeck ledger verify"), copyButton("earthdeck ledger verify"));
  const links = el("div", "verify-links");
  links.append(link(`/api/ledger/${encodeURIComponent(f.findingId)}`, "Events + inclusion proof (JSON)"), link("/ledger/checkpoint", "Signed checkpoint"), link("/ledger/pub", "Public key"));
  box.append(cmd, links);

  void Promise.all([
    fetch(`/api/ledger/${encodeURIComponent(f.findingId)}`).then((r) => (r.ok ? (r.json() as Promise<CaseResponse>) : null)),
    fetch("/ledger/checkpoint").then((r) => (r.ok ? r.text() : null)),
  ])
    .then(([c, cp]) => {
      body.replaceChildren();
      const kv = el("dl", "kv");
      const row = (k: string, v: HTMLElement | string) => kv.append(el("dt", "", k), typeof v === "string" ? el("dd", "", v) : wrapDd(v));
      const cpLines = cp?.split("\n") ?? [];
      if (cpLines.length >= 3) {
        row("Checkpoint", `${cpLines[0]} · size ${cpLines[1]}`);
        row("Root", hashWithCopy(b64ToHex(cpLines[2]!) ?? cpLines[2]!));
      }
      row("This case", `${f.eventCount} signed event${f.eventCount === 1 ? "" : "s"}`);
      if (c?.inclusion) row("Inclusion", `leaf #${c.inclusion.index} of ${c.inclusion.size} · ${c.inclusion.proof.length}-hash audit path`);
      row("Last event", hashWithCopy(f.lastEventHash));
      body.appendChild(kv);
    })
    .catch(() => {
      body.replaceChildren(el("p", "muted", "Couldn’t load the checkpoint — the links below still work."));
    });
  return box;
}

function b64ToHex(s: string): string | null {
  try {
    return Array.from(atob(s), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

function hashWithCopy(h: string): HTMLElement {
  const w = el("span", "hashrow");
  const code = el("code", "hash", `${h.slice(0, 12)}…${h.slice(-6)}`);
  code.title = h;
  w.append(code, copyButton(h));
  return w;
}

function wrapDd(n: HTMLElement): HTMLElement {
  const dd = el("dd");
  dd.appendChild(n);
  return dd;
}

function link(href: string, text: string): HTMLAnchorElement {
  const a = el("a", "link", text);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  return a;
}

function timelineItem(at: string | null, what: string, sub: string, cls = ""): HTMLElement {
  const li = el("li", `tl-item ${cls}`.trim());
  const t = el("time", "tl-when", at ? dateOf(at) : "");
  if (at) t.dateTime = at;
  li.append(el("span", "tl-dot"), t, el("span", "tl-what", what));
  if (sub) li.appendChild(el("span", "tl-sub", sub));
  return li;
}

function evidenceNode(e: Evidence, confirming: boolean): HTMLElement {
  const d = el("div", `evidence${confirming ? " evidence--confirm" : ""}`);
  const top = el("div", "evidence-top");
  top.append(el("span", "evidence-kind", e.kind), el("span", "evidence-src", e.source));
  if (confirming) top.appendChild(el("span", "evidence-flag", "Confirming signal"));
  d.appendChild(top);
  if (e.summary) d.appendChild(el("p", "evidence-sum", e.summary));
  if (e.values && Object.keys(e.values).length) {
    const vals = el("div", "chips");
    for (const [k, v] of Object.entries(e.values)) {
      const c = el("span", "chip chip--num");
      c.append(el("span", "chip-k", k), document.createTextNode(` ${v}`));
      vals.appendChild(c);
    }
    d.appendChild(vals);
  }
  const meta = el("div", "evidence-meta");
  meta.append(document.createTextNode(`${dateOf(e.datetime)} · ${e.method.name} v${e.method.version} · `));
  const id = el("code", "", e.id);
  meta.appendChild(id);
  d.appendChild(meta);
  if (e.href) {
    const a = link(e.href, "Source ↗");
    a.addEventListener("click", (ev) => ev.stopPropagation());
    d.appendChild(a);
  }
  return d;
}

function section(title: string, children: HTMLElement[], count?: string): HTMLElement {
  const s = el("section", "case-section");
  const h = el("h3", "section-h", title);
  if (count) h.appendChild(el("span", "section-n", count));
  s.appendChild(h);
  s.append(...children);
  return s;
}

function emptyState(): HTMLElement {
  const box = el("div", "empty empty--watch");
  box.append(
    el("div", "empty-orb"),
    el("h2", "empty-title", "No cases yet"),
    el(
      "p",
      "empty-text",
      "A case is a finding the Watch sweep opened: a rule saw a signal in a watched area and wrote the evidence to a signed, append-only ledger. It stays a candidate until an independent second signal confirms it, and is published only after human review.",
    ),
    el("div", "empty-label", "Run a sweep over the watchlists"),
    cmdRow("earthdeck watch --once"),
    el("div", "empty-label", "Or load clearly-labelled demo cases"),
    cmdRow("earthdeck ledger seed"),
  );
  return box;
}

function cmdRow(cmd: string): HTMLElement {
  const r = el("div", "cmdline");
  r.append(el("code", "cmd", cmd), copyButton(cmd));
  return r;
}

function errorState(retry: () => void): HTMLElement {
  const box = el("div", "empty");
  const b = el("button", "btn", "Retry");
  b.type = "button";
  b.addEventListener("click", retry);
  box.append(el("h2", "empty-title", "Ledger unavailable"), el("p", "empty-text", "The dashboard couldn’t read /api/ledger. Is the ledger directory readable?"), b);
  return box;
}

function skeletonRow(): HTMLElement {
  const r = el("div", "case-row skeleton-row");
  r.setAttribute("aria-hidden", "true");
  r.append(skeletonLine("35%"), skeletonLine("85%"), skeletonLine("60%"));
  return r;
}

function skeletonLine(width: string): HTMLElement {
  const s = el("span", "skel");
  s.style.width = width;
  return s;
}
