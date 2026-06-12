import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INDEX_NAMES,
  maskedClassesFor,
  maskedClassLabels,
  medianRenderEvalscript,
  medianStatEvalscript,
  S2CLOUDLESS_MASK,
  SAR_EVALSCRIPTS,
  sarWaterEvalscript,
  SCL_CLEAR_MASK,
  statEvalscript,
} from "../src/evalscripts.js";

test("INDEX_NAMES are the three supported indices", () => {
  assert.deepEqual(INDEX_NAMES.sort(), ["NBR", "NDVI", "NDWI"]);
});

test("statEvalscript masks all always-classes for every index", () => {
  for (const idx of INDEX_NAMES) {
    const script = statEvalscript(idx);
    for (const c of SCL_CLEAR_MASK.always) {
      assert.ok(script.includes(`s.SCL!==${c.id}`), `${idx} should mask SCL ${c.id}`);
    }
  }
});

test("statEvalscript masks open water for NDVI/NBR but NOT for NDWI", () => {
  assert.ok(statEvalscript("NDVI").includes("s.SCL!==6"));
  assert.ok(statEvalscript("NBR").includes("s.SCL!==6"));
  assert.ok(!statEvalscript("NDWI").includes("s.SCL!==6"), "NDWI keeps water — water is the signal");
});

test("statEvalscript clear-condition = legacy SCL mask + the s2cloudless terms", () => {
  // Guards the exact mask: the SCL part must stay byte-identical to the legacy condition,
  // with the s2cloudless CLM/CLP terms appended (Horizon 1 cloud-masking upgrade).
  const cut = S2CLOUDLESS_MASK.clpCutoff;
  assert.ok(
    statEvalscript("NDVI").includes(
      `(s.SCL!==1 && s.SCL!==3 && s.SCL!==8 && s.SCL!==9 && s.SCL!==10 && s.SCL!==6 && s.CLM!==1 && s.CLP<${cut})`,
    ),
  );
  assert.ok(
    statEvalscript("NDWI").includes(
      `(s.SCL!==1 && s.SCL!==3 && s.SCL!==8 && s.SCL!==9 && s.SCL!==10 && s.CLM!==1 && s.CLP<${cut})`,
    ),
  );
});

test("statEvalscript requests the CLM/CLP bands it masks on", () => {
  for (const idx of INDEX_NAMES) {
    const script = statEvalscript(idx);
    assert.ok(script.includes('"CLM"') && script.includes('"CLP"'), `${idx} inputs CLM+CLP`);
  }
  // The CLP cutoff stays a sane probability on the 0–255 scale.
  assert.ok(S2CLOUDLESS_MASK.clpCutoff > 0 && S2CLOUDLESS_MASK.clpCutoff < 255);
});

test("statEvalscript uses the correct bands per index and is a valid v3 script", () => {
  const ndvi = statEvalscript("NDVI");
  assert.ok(ndvi.includes("//VERSION=3"));
  assert.ok(ndvi.includes('"B08"') && ndvi.includes('"B04"'), "NDVI uses NIR/Red");
  assert.ok(ndvi.includes("FLOAT32") && ndvi.includes("dataMask"));
  assert.ok(statEvalscript("NBR").includes('"B12"'), "NBR uses SWIR");
});

test("statEvalscript throws on an unknown index", () => {
  assert.throws(() => statEvalscript("EVI"), /unknown index 'EVI'/);
});

test("SAR_EVALSCRIPTS provide vv/vh/falseColor over Sentinel-1 VV/VH bands", () => {
  assert.deepEqual(Object.keys(SAR_EVALSCRIPTS).sort(), ["falseColor", "vh", "vv"]);
  for (const [view, script] of Object.entries(SAR_EVALSCRIPTS)) {
    assert.ok(script.includes("//VERSION=3"), `${view} is a v3 script`);
    assert.ok(/output:\{bands:3\}/.test(script), `${view} outputs an RGB image`);
  }
  assert.ok(SAR_EVALSCRIPTS.vv!.includes('"VV"') && !SAR_EVALSCRIPTS.vv!.includes('"VH"'));
  assert.ok(SAR_EVALSCRIPTS.vh!.includes('"VH"'));
  assert.ok(SAR_EVALSCRIPTS.falseColor!.includes('"VV"') && SAR_EVALSCRIPTS.falseColor!.includes('"VH"'));
});

test("sarWaterEvalscript embeds the linear threshold and outputs a binary FLOAT32 band", () => {
  const script = sarWaterEvalscript(0.02);
  assert.ok(script.includes("//VERSION=3"));
  assert.ok(script.includes('"VV"') && script.includes('"dataMask"'), "reads VV + dataMask");
  assert.ok(script.includes("FLOAT32"));
  assert.ok(script.includes("s.VV<0.02"), "threshold inlined; water = VV below it");
  assert.ok(/water=\(s\.VV<0\.02\)\?1:0/.test(script), "binary 0/1 → mean is the water fraction");
});

// ---- temporal-median compositing (Horizon 1 #4) ----------------------------------------

test("medianStatEvalscript uses ORBIT mosaicking and the SAME clear mask as statEvalscript", () => {
  for (const idx of INDEX_NAMES) {
    const median = medianStatEvalscript(idx);
    const single = statEvalscript(idx);
    assert.ok(median.includes('mosaicking:"ORBIT"'), `${idx} median uses ORBIT mosaicking`);
    // Extract the clear condition from the single-mosaic script and require it verbatim in
    // the median script — the two masks must never drift apart.
    const m = single.match(/var clear=\((.+)\)\?1:0;/);
    assert.ok(m, "statEvalscript exposes its clear condition");
    assert.ok(median.includes(m![1]!), `${idx} median reuses the exact clear condition`);
  }
});

test("medianStatEvalscript outputs FLOAT32 median + dataMask=0 when no clear samples", () => {
  const script = medianStatEvalscript("NDVI");
  assert.ok(script.includes("FLOAT32") && script.includes('{id:"dataMask",bands:1}'));
  assert.ok(script.includes("function median(v)"), "embeds the median helper");
  assert.ok(script.includes("return {data:[0],dataMask:[0]}"), "no clear obs → masked out");
  assert.ok(script.includes("return {data:[median(vals)],dataMask:[1]}"));
  assert.ok(script.includes('"B08"') && script.includes('"B04"'), "NDVI bands");
  assert.throws(() => medianStatEvalscript("EVI"), /unknown index 'EVI'/);
});

test("medianStatEvalscript keeps water for NDWI, drops it for NDVI/NBR", () => {
  assert.ok(medianStatEvalscript("NDVI").includes("s.SCL!==6"));
  assert.ok(medianStatEvalscript("NBR").includes("s.SCL!==6"));
  assert.ok(!medianStatEvalscript("NDWI").includes("s.SCL!==6"), "NDWI keeps water");
});

test("medianRenderEvalscript builds ORBIT median composites for every render view", () => {
  for (const view of ["trueColor", "falseColor", "ndvi"]) {
    const script = medianRenderEvalscript(view);
    assert.ok(script.includes("//VERSION=3"), `${view} is a v3 script`);
    assert.ok(script.includes('mosaicking:"ORBIT"'), `${view} uses ORBIT mosaicking`);
    assert.ok(/output:\{bands:3\}/.test(script), `${view} outputs RGB`);
    assert.ok(script.includes("function median(v)"), `${view} embeds the median helper`);
    assert.ok(!script.includes("s.SCL!==6"), `${view} render KEEPS water (imagery shows water)`);
    assert.ok(script.includes("s.SCL!==9") && script.includes(`s.CLP<${S2CLOUDLESS_MASK.clpCutoff}`), `${view} masks clouds`);
  }
  assert.throws(() => medianRenderEvalscript("nope"), /unknown view 'nope'/);
});

test("medianRenderEvalscript channel order matches the single-mosaic views", () => {
  const tc = medianRenderEvalscript("trueColor");
  assert.ok(tc.includes("median(c.B04),2.5*median(c.B03),2.5*median(c.B02)"), "trueColor = R,G,B");
  const fc = medianRenderEvalscript("falseColor");
  assert.ok(fc.includes("median(c.B08),2.5*median(c.B04),2.5*median(c.B03)"), "falseColor = NIR,R,G");
  const nd = medianRenderEvalscript("ndvi");
  assert.ok(nd.includes("(s.B08-s.B04)/(s.B08+s.B04)") && nd.includes("if(n<-0.2)"), "ndvi medians the index then ramps");
});

test("median JS helper is correct (odd, even, unsorted input)", () => {
  // Execute the embedded helper exactly as Sentinel Hub would.
  const script = medianStatEvalscript("NDVI");
  const src = script.split("\n").find((l) => l.startsWith("function median"))!;
  const median = new Function(`${src}; return median;`)() as (v: number[]) => number;
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([5]), 5);
});

test("maskedClassLabels: water toggle drives the one-class difference", () => {
  assert.equal(maskedClassLabels(true).length, maskedClassLabels(false).length + 1);
  assert.ok(maskedClassLabels(true).some((l) => l.includes("open water")));
  assert.ok(!maskedClassLabels(false).some((l) => l.includes("open water")));
});

test("maskedClassesFor lists SCL classes + the s2cloudless entry (7 for NDVI/NBR, 6 for NDWI)", () => {
  assert.equal(maskedClassesFor("NDVI").length, 7);
  assert.equal(maskedClassesFor("NBR").length, 7);
  assert.equal(maskedClassesFor("NDWI").length, 6);
  assert.ok(maskedClassesFor("NDVI").some((l) => l.includes("open water")));
  assert.ok(!maskedClassesFor("NDWI").some((l) => l.includes("open water")));
  for (const idx of INDEX_NAMES) {
    assert.ok(
      maskedClassesFor(idx).includes(S2CLOUDLESS_MASK.label),
      `${idx} provenance lists the s2cloudless layer`,
    );
  }
});
