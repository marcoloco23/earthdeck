// Browser test (not part of the offline `pnpm test`): every single-case dot on the landing map
// opens its case when clicked — dead centre and 11 px off (dots take clicks within 12 px, picked in screen space) — at
// zoom 2, 4, 6 and 9. Needs a served export and a Playwright browser:
//   node dist/cli.js watch export --out /tmp/site --base-url http://localhost:8080
//   npx -y serve -l 8080 /tmp/site   (or any static server)
//   npx playwright install chromium   (once)
//   E2E_BASE=http://127.0.0.1:8080 pnpm test:e2e

import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:8080";
const CENTRES = [[-55, -8], [47.5, 32], [-100, 35]];

test("map dots are clickable at zoom 2, 4, 6, 9", { timeout: 600_000 }, async () => {
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 860 } })).newPage();
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForSelector(".xp .maplibregl-canvas", { timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector(".xp")?.xpMap?.getLayer("pt"), null, { timeout: 30_000 });
    let clicked = 0;
    const misses = [];
    for (const z of [2, 4, 6, 9]) {
      for (const centre of CENTRES) {
        // Dots in view, not under the panel/time bar/chips (those are on top by design).
        const dots = await page.evaluate(async ({ centre, z }) => {
          const m = document.querySelector(".xp").xpMap;
          m.jumpTo({ center: centre, zoom: z });
          await new Promise((r) => { m.once("idle", r); setTimeout(r, 3000); });
          const cv = m.getCanvas().getBoundingClientRect();
          return m.queryRenderedFeatures({ layers: ["pt"] }).map((f) => {
            const p = m.project(f.geometry.coordinates);
            // On the globe, tiles also hold dots behind the horizon; project() still returns a
            // pixel for them. Keep only dots whose pixel maps back to them (the visible side).
            const back = m.unproject(p);
            const [lon, lat] = f.geometry.coordinates;
            const front = Math.abs(back.lat - lat) < 0.5 && Math.abs(((back.lng - lon + 540) % 360) - 180) < 0.5;
            return { id: f.properties.id, x: cv.x + p.x, y: cv.y + p.y, front };
          }).filter((d) => d.front && document.elementFromPoint(d.x, d.y) === m.getCanvas() && document.elementFromPoint(d.x + 11, d.y) === m.getCanvas()).slice(0, 2);
        }, { centre, z });
        for (const d of dots) {
          for (const dx of [0, 11]) {
            await page.evaluate(() => history.replaceState(null, "", `${location.pathname}#map:v=1`));
            await page.mouse.move(d.x + dx, d.y);
            await page.mouse.click(d.x + dx, d.y);
            await page.waitForTimeout(800);
            const hash = decodeURIComponent(await page.evaluate(() => location.hash));
            clicked++;
            if (!hash.includes(d.id)) misses.push(`z=${z} dx=${dx} ${d.id} → ${hash}`);
            await page.keyboard.press("Escape");
            await page.evaluate(({ centre, z }) => document.querySelector(".xp").xpMap.jumpTo({ center: centre, zoom: z }), { centre, z });
            await page.waitForTimeout(400);
          }
        }
      }
    }
    assert.ok(clicked >= 8, `only ${clicked} dots were in view to click`);
    assert.deepEqual(misses, []);
  } finally {
    await browser.close();
  }
});
