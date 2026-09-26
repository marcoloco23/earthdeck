// Small shared DOM + motion helpers. Everything builds nodes with textContent — never
// innerHTML from data — because card and ledger content originates outside this page.

/** The house curve (strong ease-out) — mirrors `--ease-out` in styles.css for WAAPI calls. */
export const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

const reduceQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
export function reducedMotion(): boolean {
  return reduceQuery?.matches ?? false;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** "just now", "42s ago", "7m ago", "3h ago", "2d ago" — for telemetry, not for records. */
export function ago(iso: string | number, now = Date.now()): string {
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** YYYY-MM-DD for record dates (UTC, as stored). */
export function dateOf(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

/** A tiny copy-to-clipboard button; the label flips to "Copied" briefly as feedback. */
export function copyButton(value: string, label = "Copy"): HTMLButtonElement {
  const b = el("button", "btn btn--ghost btn--xs", label);
  b.type = "button";
  b.title = `Copy ${value.length > 40 ? `${value.slice(0, 40)}…` : value}`;
  let timer = 0;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    void navigator.clipboard?.writeText(value).then(
      () => {
        b.textContent = "Copied";
        b.classList.add("is-done");
        clearTimeout(timer);
        timer = window.setTimeout(() => {
          b.textContent = label;
          b.classList.remove("is-done");
        }, 1400);
      },
      () => {
        b.textContent = "Copy failed";
      },
    );
  });
  return b;
}

export function safeStatus(status: string): string {
  return /^[a-z_]+$/.test(status) ? status : "unknown";
}

export function statusBadge(status: string): HTMLElement {
  const b = el("span", `status-badge status--${safeStatus(status)}`);
  b.append(el("span", "status-dot"), document.createTextNode(status.replace(/_/g, " ")));
  return b;
}

export function tierBadge(tier: number | undefined): HTMLElement {
  const t = typeof tier === "number" && tier >= 0 && tier <= 3 ? tier : null;
  const b = el("span", `tier tier--${t ?? "x"}`, t === null ? "T?" : `T${t}`);
  b.title = t === null ? "Tier unknown" : TIER_HINT[t]!;
  return b;
}

const TIER_HINT = [
  "Tier 0 — informational, no publication gate",
  "Tier 1 — publishing needs one human approval",
  "Tier 2 — publishing needs two distinct human approvals; naming a party allowed",
  "Tier 3 — private notice + right-of-reply window before publication",
];
