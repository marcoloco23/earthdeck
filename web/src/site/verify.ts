// A case's proof, checked in the browser with WebCrypto against the files this site serves: the
// signed checkpoint, the hash tile holding the case's latest event, and its Merkle audit path.
// Runs on a case page and on a case opened in the landing's panel (same server-rendered box).

import { apiPaths } from "../api";
import { bytesToHex, leafTile, parseCheckpoint, verifyCheckpointSignature, verifyInclusion } from "../proof";

export async function verifyCase(box: HTMLElement, prefix: string): Promise<void> {
  if (!box.dataset.leaf) return;
  const api = apiPaths("static", prefix);
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

/** Reveal and wire the server-rendered copy buttons under `root`. */
export function wireCopy(root: ParentNode): void {
  for (const b of root.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
    if (!b.hidden) continue;
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
}
