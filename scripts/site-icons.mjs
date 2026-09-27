#!/usr/bin/env node
// One-off, dev-only: render the site's icon set and social card from web/site/public/favicon.svg
// into committed PNGs (web/site/public/). Not part of `pnpm build` — the PNGs are checked in, so
// no image tooling is a dependency. Needs Playwright (any recent version with Chromium) on the
// NODE_PATH, e.g. `NODE_PATH=$(npm root -g) node scripts/site-icons.mjs`, and ImageMagick for
// favicon.ico. Re-run after changing the mark or SITE.name / SITE.byline.
//
//   apple-touch-icon.png 180 · icon-192.png · icon-512.png · favicon.ico (16/32/48) · og.png 1200×630

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const PUB = new URL("../web/site/public/", import.meta.url).pathname;
const svg = readFileSync(join(PUB, "favicon.svg"), "utf8");
// Branding comes from src/site.config.ts; parsed textually so this script needs no TS loader.
const cfg = readFileSync(new URL("../src/site.config.ts", import.meta.url), "utf8");
const name = /^\s*name:\s*"([^"]+)"/m.exec(cfg)[1];
const tagline = [.../^\s*tagline:\s*\[([^\]]+)\]/m.exec(cfg)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).join(" ");

const browser = await chromium.launch();
const shot = async (html, w, h, out) => {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await p.setContent(html, { waitUntil: "networkidle" });
  await p.screenshot({ path: join(PUB, out), omitBackground: false });
  await p.close();
};
const iconPage = (px, pad) =>
  `<html><body style="margin:0;background:#0c1016;width:${px}px;height:${px}px;display:grid;place-items:center">` +
  `<div style="width:${px - pad * 2}px;height:${px - pad * 2}px">${svg.replace("<svg ", '<svg width="100%" height="100%" ')}</div></body></html>`;

// Touch/PWA icons: full-bleed square (the OS rounds the corners), mark inset a little.
await shot(iconPage(180, 0), 180, 180, "apple-touch-icon.png");
await shot(iconPage(192, 0), 192, 192, "icon-192.png");
await shot(iconPage(512, 0), 512, 512, "icon-512.png");
for (const s of [16, 32, 48]) await shot(iconPage(s, 0), s, s, `fav-${s}.png`);
execFileSync("magick", [join(PUB, "fav-16.png"), join(PUB, "fav-32.png"), join(PUB, "fav-48.png"), join(PUB, "favicon.ico")]);
for (const s of [16, 32, 48]) rmSync(join(PUB, `fav-${s}.png`));

// Social card: the mark, the wordmark and the slogan on the site's dark ground, a faint horizon.
const og = `<html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap"></head>
<body style="margin:0;width:1200px;height:630px;background:#07090d;font-family:Inter,system-ui,sans-serif;position:relative;overflow:hidden">
  <svg width="1200" height="630" style="position:absolute;inset:0" viewBox="0 0 1200 630">
    <defs><radialGradient id="g" cx="50%" cy="100%" r="75%"><stop offset="0" stop-color="#5cc8ff" stop-opacity=".22"/><stop offset=".6" stop-color="#5cc8ff" stop-opacity=".04"/><stop offset="1" stop-color="#5cc8ff" stop-opacity="0"/></radialGradient></defs>
    <circle cx="600" cy="1530" r="1100" fill="url(#g)"/>
    <circle cx="600" cy="1530" r="1100" fill="none" stroke="#5cc8ff" stroke-opacity=".35" stroke-width="2"/>
  </svg>
  <div style="position:absolute;left:96px;top:150px;display:flex;align-items:center;gap:32px">
    <div style="width:132px;height:132px">${svg.replace("<svg ", '<svg width="100%" height="100%" ')}</div>
    <div style="font-size:112px;font-weight:600;letter-spacing:-0.035em;color:#e7ecf3;line-height:1">${name}</div>
  </div>
  <div style="position:absolute;left:100px;top:326px;font-size:46px;font-weight:400;letter-spacing:-0.01em;color:#aab4c2">${tagline}</div>
</body></html>`;
await shot(og, 1200, 630, "og.png");
await browser.close();
console.log(`icons + og.png → ${PUB}`);
