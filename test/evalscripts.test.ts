import { test } from "node:test";
import assert from "node:assert/strict";
import { INDEX_NAMES, maskedClassesFor, SCL_CLEAR_MASK, statEvalscript } from "../src/evalscripts.js";

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

test("statEvalscript clear-condition is byte-identical to the legacy hardcoded mask", () => {
  // Guards the refactor that moved the mask into SCL_CLEAR_MASK.
  assert.ok(statEvalscript("NDVI").includes("(s.SCL!==1 && s.SCL!==3 && s.SCL!==8 && s.SCL!==9 && s.SCL!==10 && s.SCL!==6)"));
  assert.ok(statEvalscript("NDWI").includes("(s.SCL!==1 && s.SCL!==3 && s.SCL!==8 && s.SCL!==9 && s.SCL!==10)"));
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

test("maskedClassesFor lists 6 classes for NDVI/NBR and 5 for NDWI", () => {
  assert.equal(maskedClassesFor("NDVI").length, 6);
  assert.equal(maskedClassesFor("NBR").length, 6);
  assert.equal(maskedClassesFor("NDWI").length, 5);
  assert.ok(maskedClassesFor("NDVI").some((l) => l.includes("open water")));
  assert.ok(!maskedClassesFor("NDWI").some((l) => l.includes("open water")));
  assert.ok(maskedClassesFor("NDVI").every((l) => /SCL \d+/.test(l)), "labels carry the SCL id");
});
