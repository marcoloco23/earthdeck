import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AEF_BANDS,
  dequantize,
  indexOrderKey,
  keyOfChunk,
  openAefCog,
  parseIndexRows,
  pickLevel,
  readEmbedWindow,
} from "../src/clients/aef.js";
import { topKThinned } from "../src/tools/similar.js";
import { mockFetch } from "./helpers.js";

// ---- index parsing / ordering -----------------------------------------------------------

const ROW =
  '"POLYGON((-180 52.45,-179.4 52.47,-179.4 51.7,-180 51.72,-180 52.45))",EPSG:32601,' +
  "s3://us-west-2.opendata.source.coop/tge-labs/aef/v1/annual/2017/1N/xw2v5q2txl4tnk5uk-0000000000-0000008192.tiff," +
  "2017,1N,254240,5734400,336160,5816320,-180,51.7221845203638,-179.372833637904,52.472418567314";

test("parseIndexRows extracts the non-WKT tail and rewrites s3:// to the https mirror", () => {
  const rows = parseIndexRows(ROW + "\n");
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.epsg, 32601);
  assert.match(r.url, /^https:\/\/.*\/2017\/1N\/xw2v5q2txl4tnk5uk-0000000000-0000008192\.tiff$/);
  assert.equal(r.year, 2017);
  assert.equal(r.zone, "1N");
  assert.equal(r.utmWest, 254240);
  assert.equal(r.utmNorth, 5816320);
  assert.equal(r.w84West, -180);
  assert.ok(Math.abs(r.w84North - 52.472418567314) < 1e-9);
});

test("parseIndexRows handles multiple rows and ignores partial fragments", () => {
  const rows = parseIndexRows("garbage,EPSG:123,nope\n" + ROW + "\n" + ROW);
  assert.equal(rows.length, 2);
});

test("index order key: zone-major (N before S, numeric), year ascending", () => {
  const k = (z: number, s: boolean, y: number) => indexOrderKey(z, s, y);
  assert.ok(k(1, false, 2025) < k(2, false, 2017), "2N comes after all of 1N");
  assert.ok(k(60, false, 2025) < k(1, true, 2017), "all N zones before any S zone");
  assert.ok(k(21, true, 2019) < k(21, true, 2020), "years ascend within a zone");
  assert.ok(k(9, false, 2024) < k(10, false, 2017), "numeric, not lexicographic");
});

test("keyOfChunk finds the first row key in arbitrary CSV fragments", () => {
  assert.equal(keyOfChunk("…/annual/2019/21S/file.tiff,…"), indexOrderKey(21, true, 2019));
  assert.equal(keyOfChunk("no rows here"), null);
});

// ---- synthetic bottom-up BigTIFF fixture -------------------------------------------------

/**
 * Build a minimal AEF-shaped BigTIFF in memory: 4×4 px base level, 64 int8 bands,
 * planar=2, 4×4 tiles (single tile per band), compression=1 (none), bottom-up transform
 * x = 100000 + 10·col, y = 5000000 + 10·row. Pixel values encode position+band so the
 * reader's indexing can be asserted exactly.
 */
function buildFixture(): { buf: Buffer; px: (band: number, row: number, col: number) => number } {
  const W = 4;
  const tileBytes = W * W;
  const headerGuess = 8 * 1024;
  const tiles: Buffer[] = [];
  const px = (b: number, r: number, c: number): number => {
    if (r === 0 && c === 0) return -128; // SW corner = nodata in every band
    return ((b * 7 + r * 3 + c) % 100) + 1; // deterministic, positive, ≠ -128
  };
  for (let b = 0; b < 64; b++) {
    const t = Buffer.alloc(tileBytes);
    for (let r = 0; r < W; r++) for (let c = 0; c < W; c++) t.writeInt8(px(b, r, c), r * W + c);
    tiles.push(t);
  }

  const buf = Buffer.alloc(headerGuess + 64 * tileBytes);
  buf.write("II", 0, "latin1");
  buf.writeUInt16LE(43, 2); // BigTIFF
  buf.writeUInt16LE(8, 4);
  buf.writeBigUInt64LE(16n, 8); // first IFD at 16

  const entries: Array<[number, number, number, number | bigint]> = [];
  const T_SHORT = 3, T_LONG = 4, T_LONG8 = 16, T_DOUBLE = 12;
  // Out-of-line arrays live after the IFD; lay them out at fixed offsets.
  const nTags = 13;
  const ifdStart = 16;
  const ifdSize = 8 + nTags * 20 + 8;
  let extra = ifdStart + ifdSize;
  const bitsOff = extra; extra += 64 * 2; // 64 × SHORT 8
  const sfOff = extra; extra += 64 * 2; // 64 × SHORT 2 (signed int)
  const toOff = extra; extra += 64 * 8; // tile offsets
  const tbOff = extra; extra += 64 * 4; // tile byte counts
  const trOff = extra; extra += 16 * 8; // ModelTransformation
  const dataStart = headerGuess;

  for (let i = 0; i < 64; i++) {
    buf.writeUInt16LE(8, bitsOff + i * 2);
    buf.writeUInt16LE(2, sfOff + i * 2);
    buf.writeBigUInt64LE(BigInt(dataStart + i * tileBytes), toOff + i * 8);
    buf.writeUInt32LE(tileBytes, tbOff + i * 4);
  }
  const transform = [10, 0, 0, 100000, 0, 10, 0, 5000000, 0, 0, 0, 0, 0, 0, 0, 1];
  transform.forEach((v, i) => buf.writeDoubleLE(v, trOff + i * 8));

  entries.push([256, T_SHORT, 1, W]); // width
  entries.push([257, T_SHORT, 1, W]); // height
  entries.push([258, T_SHORT, 64, bitsOff]);
  entries.push([259, T_SHORT, 1, 1]); // compression: none
  entries.push([262, T_SHORT, 1, 1]);
  entries.push([277, T_SHORT, 1, 64]); // spp
  entries.push([284, T_SHORT, 1, 2]); // planar
  entries.push([322, T_SHORT, 1, W]); // tile width
  entries.push([323, T_SHORT, 1, W]); // tile height
  entries.push([324, T_LONG8, 64, toOff]);
  entries.push([325, T_LONG, 64, tbOff]);
  entries.push([339, T_SHORT, 64, sfOff]);
  entries.push([34264, T_DOUBLE, 16, trOff]);
  entries.sort((a, b) => a[0] - b[0]);

  buf.writeBigUInt64LE(BigInt(nTags), ifdStart);
  entries.forEach(([tag, typ, cnt, val], i) => {
    const e = ifdStart + 8 + i * 20;
    buf.writeUInt16LE(tag, e);
    buf.writeUInt16LE(typ, e + 2);
    buf.writeBigUInt64LE(BigInt(cnt), e + 4);
    buf.writeBigUInt64LE(BigInt(val), e + 12);
  });
  buf.writeBigUInt64LE(0n, ifdStart + 8 + nTags * 20); // end of IFD chain

  tiles.forEach((t, i) => t.copy(buf, dataStart + i * tileBytes));
  return { buf, px };
}

function mockRangeServer(buf: Buffer) {
  return mockFetch((url, call) => {
    const m = /bytes=(\d+)-(\d+)/.exec(call.headers["range"] ?? "");
    if (!m) return new Response(new Uint8Array(buf), { status: 200 });
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), buf.length - 1);
    return new Response(new Uint8Array(buf.subarray(start, end + 1)), { status: 206 });
  });
}

test("openAefCog parses the synthetic bottom-up BigTIFF and asserts its invariants", async (t) => {
  const { buf } = buildFixture();
  const mock = mockRangeServer(buf);
  t.after(mock.restore);
  const info = await openAefCog("https://example.test/fixture.tiff");
  assert.equal(info.x0, 100000);
  assert.equal(info.y0, 5000000);
  assert.equal(info.levels.length, 1);
  assert.equal(info.levels[0]!.width, 4);
  assert.equal(info.levels[0]!.tilesPerBand, 1);
  // cellM = transform pixel size × downsample vs the file's own base level.
  assert.equal(info.levels[0]!.cellM, 10);
});

test("openAefCog rejects non-BigTIFF bytes", async (t) => {
  const mock = mockRangeServer(Buffer.from("MM\x00\x2a not a bigtiff at all padding padding"));
  t.after(mock.restore);
  await assert.rejects(() => openAefCog("https://example.test/bad.tiff"), /not a little-endian BigTIFF/);
});

test("readEmbedWindow dequantizes, renormalizes, maps bottom-up rows, flags nodata", async (t) => {
  const { buf, px } = buildFixture();
  const mock = mockRangeServer(buf);
  t.after(mock.restore);
  const info = await openAefCog("https://example.test/fixture.tiff");
  const cell = info.levels[0]!.cellM;
  const grid = await readEmbedWindow(info, { epsg: 32633 }, 0, {
    west: 100000,
    south: 5000000,
    east: 100000 + 4 * cell,
    north: 5000000 + 4 * cell,
  });
  assert.equal(grid.rows, 4);
  assert.equal(grid.cols, 4);
  assert.equal(grid.epsg, 32633);
  // Row 0 of the grid = SOUTH row = tile row 0 (bottom-up file ⇒ no flip needed).
  assert.equal(grid.valid[0], 0, "SW corner is nodata");
  assert.equal(grid.valid[1], 1);
  // Vector at (row 2, col 3) must be the dequantized+renormalized fixture values.
  const r = 2, c = 3;
  const raw = Array.from({ length: 64 }, (_, b) => dequantize(px(b, r, c)));
  const norm = Math.hypot(...raw);
  for (const b of [0, 17, 63]) {
    const got = grid.data[(r * grid.cols + c) * AEF_BANDS + b]!;
    assert.ok(Math.abs(got - raw[b]! / norm) < 1e-6, `band ${b}: ${got} vs ${raw[b]! / norm}`);
  }
  // All valid vectors are unit length.
  let s = 0;
  for (let b = 0; b < 64; b++) s += grid.data[(r * grid.cols + c) * AEF_BANDS + b]! ** 2;
  assert.ok(Math.abs(s - 1) < 1e-6);
});

test("readEmbedWindow clamps partial windows and rejects non-intersecting ones", async (t) => {
  const { buf } = buildFixture();
  const mock = mockRangeServer(buf);
  t.after(mock.restore);
  const info = await openAefCog("https://example.test/fixture.tiff");
  const cell = info.levels[0]!.cellM;
  const grid = await readEmbedWindow(info, { epsg: 1 }, 0, {
    west: 100000 + 2.5 * cell,
    south: 5000000 - 99 * cell,
    east: 100000 + 99 * cell,
    north: 5000000 + 1.5 * cell,
  });
  assert.equal(grid.cols, 2, "cols clamped to file edge");
  assert.equal(grid.rows, 2);
  assert.equal(grid.utmWest, 100000 + 2 * cell);
  await assert.rejects(
    () => readEmbedWindow(info, { epsg: 1 }, 0, { west: 0, south: 0, east: 1, north: 1 }),
    /does not intersect/,
  );
});

// ---- math helpers -----------------------------------------------------------------------

test("dequantize: sign(v)·(v/127.5)², nodata excluded upstream", () => {
  assert.equal(dequantize(0), 0);
  assert.ok(Math.abs(dequantize(127) - (127 / 127.5) ** 2) < 1e-12);
  assert.ok(Math.abs(dequantize(-127) + (127 / 127.5) ** 2) < 1e-12);
  assert.ok(dequantize(64) > 0 && dequantize(-64) < 0);
});

test("topKThinned keeps the best and enforces spatial separation", () => {
  const cands = [
    { lon: 0, lat: 0, similarity: 0.99 },
    { lon: 0.0001, lat: 0.0001, similarity: 0.98 }, // too close to #1
    { lon: 1, lat: 1, similarity: 0.97 },
    { lon: 2, lat: 2, similarity: 0.5 },
  ];
  const top = topKThinned(cands, 3, 0.01);
  assert.equal(top.length, 3);
  assert.equal(top[0]!.similarity, 0.99);
  assert.equal(top[1]!.similarity, 0.97, "near-duplicate was thinned");
  assert.equal(top[2]!.similarity, 0.5);
});
