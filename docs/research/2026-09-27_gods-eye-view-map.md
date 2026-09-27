# God's Eye View → the TerraKeep map (2026-09-27)

Source: [bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view), read at `b210ab0`.
It is a Cesium 3D-globe "spy-satellite simulator": live flights, ships, satellites, CCTV, weather,
wildfires, with GLSL "sensor looks". The code is MIT. **The bundled data is not.** Its TeleGeography
cables are CC BY-NC-SA, its Bhote Koshi imagery and derived coordinates are CC BY-NC, its OSM
extracts are ODbL, and its 3D models each have their own licence. Google tiles and OpenSky
restrict commercial use. We took ideas and patterns only: no code, no data, no assets.

## What they do well

- **Every layer has the same shape.** Each data source (e.g. `src/layers/firms/`) is split into
  `source` / `model` / `rendering` / `cards` / `selection` / `lifecycle`. A source is just
  `getSnapshot({signal})`. When it has no key it returns `keyRequired`. Malformed payloads are
  refused, never drawn.
- **Degradation is honest.** The loading-feedback model keeps `loading`, `error`,
  `unavailable`, `keyRequired` and `degraded` apart. It also knows that "empty" or "zoom in"
  are prompts, not failures. A chip that can't be used says why, and never flips its state
  before the switch actually succeeds.
- **The share link is a handoff.** `src/sharelink.js` writes the camera, style, layers and
  tracked target into the URL hash. Its rules:
  - Writes use `history.replaceState`, debounced, and are versioned (`v=2`).
  - Layer tokens are one letter each, from a fixed registry.
  - A single unknown token rejects the whole layer set (fail closed).
  - Fields have length caps, and numbers are clamped on both read and write.
  - Nothing is written until the restore has finished.
  - Any gesture from the recipient beats a pending restore flight.
  - A copy-time `at=` stamp lets a stale tracked target say "expired" instead of silently
    pointing at nothing.
- **Keyless search is layered and strict.** Coordinates come first. The parser accepts decimal
  degrees only: a sign, or one N/S/E/W letter per part. It rejects a sign plus a letter together,
  two letters on the same axis, and trailing text. Then come bundled exact names, then
  Photon/Nominatim, each with a timeout and a cache.
- **Selection is guarded.** A focus request is validated before it takes the camera, and a
  generation stamp stops a slow request from yanking the view after a newer one. Framing is
  set per kind of thing. Escape closes only the innermost panel and returns focus to the button
  that opened it.
- **Time is one clock.** Weather replay has a single clock over the union of every product's
  frames. Each product has a `maxGapMs`, and the UI labels it "synced" vs "nearest". Play waits
  until every layer has loaded the current frame. The slider is native, with `aria-valuetext`.
- **Global Context** enters a named bundle of layers as one transaction. On exit it restores
  what you had, plus what you added inside minus what you removed. It restores layers, not the
  camera.
- **Budgets are explicit.** Rendering happens only on demand, using named "holds", which cut
  idle GPU use by about 60 %. First-run hints are suppressed on shared links, and their storage
  access survives private-mode Safari.

## What transfers to a cases-and-evidence site, and what doesn't

Their product is a live-feed toy: things move, and the fun is following them. Ours is a
**record**: a case is a claim with evidence, a status and a date, and it must not move. So:

- **Tracking becomes selecting a case.** Our "target" is a case id. The card shows only what
  the ledger says (headline, status, place, the value of nature at stake, the date seen) and
  links to the full case page. There are no trails. The time scrubber takes their place: cases
  fade in as `observedAt` passes.
- **Their weather replay becomes a replay of the record.** The clock runs over case dates, not
  radar frames. A window of 30 / 90 / 365 days or all time, a day slider, and a Replay that
  sweeps it. It is linear on purpose: it shows time passing, not an object moving. The stats
  strip counts only the window.
- **Share links matter even more for us.** A journalist, a reviewer or the party named in a
  case should be able to send exactly what they saw: camera, layers, time window, selected
  case and evidence overlays. We copied the discipline (versioned, fail-closed tokens, clamped,
  no writes before a restore or a gesture) with far fewer fields.
- **Degradation.** Every overlay is decoration over a record that already exists as HTML. If
  WebGL, GIBS, GFW or HLS fail, the reader still has the static map, the pins and the list, so
  failure is silent. There are no "LOAD FAILED" chips.
- **Global Context** is our "Whole Earth" button: all cases, all statuses including false
  alarms, all time. Unlike theirs, pressing it again (or Escape) **also restores the camera**.
  For a reader who wanders off, that is the point of the button.

## What we skipped, and why

- **Cesium, 3D Tiles and 3D models.** They are heavy, need an ion token for the good terrain,
  and a 3D city adds nothing to a forest-loss polygon. MapLibre 5.8 (already a dependency) has
  a **globe projection**, which gives us the "whole planet" feeling without them.
- **Anything that needs a key, or a key-holding proxy.** That rules out Google tiles and FIRMS
  map tiles, which need a `MAP_KEY`. The public site is static, anonymous and keyless. Fire
  cases show only their cluster centroid, which is deliberate in the rule itself: detections in
  Indigenous land are never pinned precisely.
- **GLSL sensor looks, bloom, the scope mask, cockpit, voice, SDR and CCTV.** They add
  atmosphere, not evidence. Restraint matches the site.
- **Remote geocoders (Photon, Nominatim).** Search stays offline. It uses the watched places
  (AOIs from the exported ledger) plus coordinates, so the map makes no calls a reader didn't
  cause.
- **Ambient labels, decluttering and trails.** We have tens of cases, not thousands of moving
  contacts. DOM markers with a hover tooltip are enough, and they give us focus, `aria-label`
  and CSS transitions for free.
- **NC or share-alike datasets.** We avoid them. Our sources are NASA GIBS (public domain) and
  GFW integrated alerts (CC BY 4.0), whose tiles are keyless and CORS-open, plus OSM labels via
  GIBS and OpenFreeMap as a fallback basemap (ODbL, with attribution).

## The interactions we adopted

1. **Lazy upgrade in place.** The landing and cases index ship the static NASA image with link
   pins, which works for crawlers, no-JS readers and the first paint. The MapLibre chunk and
   `api/map.json` load on hover, tap or focus, or after the page has been idle on a connection
   that isn't in save-data mode. A `#map:` link upgrades at once.
2. **Globe projection**, Blue Marble basemap and OSM labels via GIBS. If GIBS fails, the map
   falls back to OpenFreeMap.
3. **Layer toggles.** Status (Published / Being checked / Wrong or dropped) and case type
   (forest loss, fires, new flaring, flaring stopped, methane), with counts.
4. **Click to open.** A marker opens a card with the headline, status, place, living value,
   date and "Open case". The list and the map highlight each other. The camera flies with the
   site's `--ease-in-out` (`cubic-bezier(0.77, 0, 0.175, 1)`), framed per case type, and jumps
   under reduced motion.
5. **Keyboard.** Arrow keys cycle the visible cases, Enter opens the selected one, and Escape
   closes the innermost thing (layers panel, then card, then Whole Earth). Map keyboard panning
   is off so the arrows are ours.
6. **Evidence overlays per case.** Forest cases get GFW integrated alerts, in true colour, for
   the case's dates. Non-fire, non-methane cases get HLS 30 m Sentinel-2/Landsat before/after
   stacks with a crossfade slider (cheaper than a swipe, and just as legible). Each overlay is
   bounded to the case area, and an empty day is simply transparent.
7. **Time window**, scrubber and Replay. The stats strip follows the window.
8. **Share links**: `#map:v=1&c=…&z=…&p=…&b=…&g=…&k=…&w=…&t=…&s=…&o=…`, plus a Copy-link
   button. The URL is only rewritten after a gesture or a restore.
9. **Keyless search** over the watched places, case titles and coordinates.
10. **Whole Earth** (Global Context): the whole planet with every layer on, then back to
    exactly where you were.
11. **Phone.** The map is about 45 vh, the card becomes a bottom sheet, and there is no hover
    dependence: tooltips appear on mouse hover only, a tap selects, and the zoom buttons give
    way to pinch.

## Later, if useful

- The copy-time `at=` stamp: "this case changed since the link was shared".
- A tilt/north-up toggle button. Today it's the compass control plus right-drag.
- Render-on-demand holds, if we ever animate more than one thing at a time.
