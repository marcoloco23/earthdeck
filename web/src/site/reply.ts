// The reply form under a case: built only with JavaScript (without it the server-rendered
// box says replies are open on the interactive site). Posts `{caseId, text, role, website}`
// to the reply wall's intake (data-endpoint, from the export's --reply-url); `website` is a
// honeypot a person never sees. Nothing is shown until the reviewer model accepts it.

import { el } from "../ui";

// "Someone else" first and preselected: a reply is never filed under a role nobody chose.
const ROLES: [string, string][] = [
  ["other", "Someone else"],
  ["resident", "I live nearby"],
  ["operator", "I work on site"],
  ["company", "I speak for a company"],
  ["official", "I am a public official"],
  ["researcher", "I research this"],
];
const MIN = 20;
const MAX = 2000;

export function mountReplyForms(root: ParentNode): void {
  for (const box of root.querySelectorAll<HTMLElement>(".reply-box[data-case][data-endpoint]")) {
    if (box.dataset.mounted) continue;
    const caseId = box.dataset.case!;
    const endpoint = box.dataset.endpoint!;
    if (!/^[A-Za-z0-9-]{1,64}$/.test(caseId) || !/^https:\/\//.test(endpoint)) continue;
    box.dataset.mounted = "1";
    box.querySelector(".reply-nojs")?.remove();

    const form = el("form", "reply-form");
    form.noValidate = true;
    const tId = `reply-text-${caseId}`;
    const rId = `reply-role-${caseId}`;
    const tLabel = el("label", "reply-label", "Your reply");
    tLabel.htmlFor = tId;
    const text = el("textarea", "reply-text-in");
    text.id = tId;
    text.rows = 4;
    text.maxLength = MAX;
    text.placeholder = "What do you see there? What does the case get right or wrong?";
    const rLabel = el("label", "reply-label", "Which fits you best? (leave it if none does)");
    rLabel.htmlFor = rId;
    const role = el("select", "reply-role");
    role.id = rId;
    role.name = "role";
    role.autocomplete = "off"; // no restored choice from an earlier visit
    for (const [v, t] of ROLES) {
      const o = el("option", "", t);
      o.value = v;
      role.appendChild(o);
    }
    role.value = "other";
    for (const o of role.options) o.defaultSelected = o.value === "other";
    // Honeypot: off-screen, not focusable, not announced.
    const trap = el("input", "reply-hp");
    trap.type = "text";
    trap.name = "website";
    trap.tabIndex = -1;
    trap.autocomplete = "off";
    trap.setAttribute("aria-hidden", "true");
    const hint = el("p", "reply-hint", "No names, emails, phone numbers or links — they are turned away.");
    const status = el("p", "reply-status");
    status.id = `reply-status-${caseId}`;
    text.setAttribute("aria-describedby", status.id);
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const send = el("button", "btn reply-send", "Send reply");
    send.type = "submit";
    form.append(tLabel, text, rLabel, role, trap, hint, send, status);
    box.appendChild(form);

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const body = text.value.trim();
      status.className = "reply-status reply-status--error";
      const bad = body.length < MIN ? `Please write at least ${MIN} characters.` : body.length > MAX ? `Please keep it under ${MAX} characters.` : "";
      text.toggleAttribute("aria-invalid", !!bad);
      if (bad) {
        status.textContent = bad;
        return void text.focus({ preventScroll: true });
      }
      send.disabled = true;
      status.className = "reply-status";
      status.textContent = "Sending…";
      fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ caseId, text: body, role: role.value, website: trap.value }),
      })
        .then(async (r) => {
          const j = (await r.json().catch(() => ({}))) as { message?: string };
          if (r.status === 202) {
            form.replaceChildren(el("p", "reply-status reply-status--ok", "Thanks. Replies are reviewed a few times a day: a second AI model reads yours first, and if it’s accepted it appears here."));
            return;
          }
          status.className = "reply-status reply-status--error";
          status.textContent = j.message ?? (r.status === 429 ? "Too many replies from here today — please come back tomorrow." : "That didn’t go through. Please try again later.");
        })
        .catch(() => {
          status.className = "reply-status reply-status--error";
          status.textContent = "That didn’t go through (no connection?). Please try again.";
        })
        .finally(() => {
          send.disabled = false;
        });
    });
  }
}
