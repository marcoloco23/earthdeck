// Sentinel Hub evalscripts. Render scripts return an RGB visualization; stat scripts
// return a single FLOAT32 index band + dataMask for the Statistical API.

// NDVI color ramp: blue water → tan bare → greens for increasing vegetation. Shared by the
// single-mosaic and temporal-median ndvi renders so the two views can't diverge.
const NDVI_RAMP_JS = `if(n<-0.2) return [0.05,0.05,0.4];
  if(n<0.0) return [0.6,0.6,0.6];
  if(n<0.2) return [0.85,0.8,0.55];
  if(n<0.4) return [0.74,0.83,0.38];
  if(n<0.6) return [0.42,0.72,0.22];
  return [0.1,0.5,0.05];`;

/** Visualization evalscripts for the Process API (eo_render `view`). */
export const RENDER_EVALSCRIPTS: Record<string, string> = {
  trueColor: `//VERSION=3
function setup(){return {input:["B02","B03","B04"],output:{bands:3}}}
function evaluatePixel(s){return [2.5*s.B04,2.5*s.B03,2.5*s.B02]}`,

  // Color-infrared: vegetation bright red (B08 NIR → red channel).
  falseColor: `//VERSION=3
function setup(){return {input:["B03","B04","B08"],output:{bands:3}}}
function evaluatePixel(s){return [2.5*s.B08,2.5*s.B04,2.5*s.B03]}`,

  ndvi: `//VERSION=3
function setup(){return {input:["B04","B08"],output:{bands:3}}}
function evaluatePixel(s){
  var n=(s.B08-s.B04)/(s.B08+s.B04);
  ${NDVI_RAMP_JS}
}`,
};

/**
 * Visualization evalscripts for Sentinel-1 GRD (`sar_render`). Inputs are GAMMA0
 * terrain-corrected linear backscatter (VV/VH). We apply a sqrt stretch (a cheap dB-like
 * compression of SAR's wide dynamic range) with modest gains — a sensible starting point to
 * tune against real scenes. SAR has no cloud concept: bright = rough/urban/forest, dark =
 * smooth/calm-water.
 */
export const SAR_EVALSCRIPTS: Record<string, string> = {
  // Co-pol VV backscatter, grayscale.
  vv: `//VERSION=3
function setup(){return {input:["VV"],output:{bands:3}}}
function evaluatePixel(s){var v=Math.sqrt(Math.max(0,s.VV))*1.5;return [v,v,v]}`,

  // Cross-pol VH backscatter (volume scattering → vegetation), grayscale.
  vh: `//VERSION=3
function setup(){return {input:["VH"],output:{bands:3}}}
function evaluatePixel(s){var v=Math.sqrt(Math.max(0,s.VH))*2.5;return [v,v,v]}`,

  // False color: R=VV, G=VH, B=VV/VH ratio — urban bright, vegetation greenish, water dark.
  falseColor: `//VERSION=3
function setup(){return {input:["VV","VH"],output:{bands:3}}}
function evaluatePixel(s){
  var vv=Math.max(0,s.VV), vh=Math.max(0,s.VH);
  return [Math.sqrt(vv)*1.5, Math.sqrt(vh)*2.5, (vv/(vh+1e-6))*0.1];
}`,
};

/**
 * Statistical evalscript for SAR water/flood extent. Water (and other smooth surfaces)
 * specularly reflect radar away from the sensor → very low VV backscatter, so VV γ⁰ below a
 * threshold marks water. Outputs a binary band (1 = water), so the Statistical API's `mean`
 * over the AOI is the **water-covered fraction**. `threshLinear` is the VV γ⁰ cutoff in linear
 * power (convert from dB with 10^(dB/10)).
 */
export function sarWaterEvalscript(threshLinear: number): string {
  return `//VERSION=3
function setup(){return {input:[{bands:["VV","dataMask"]}],output:[{id:"data",bands:1,sampleType:"FLOAT32"},{id:"dataMask",bands:1}]}}
function evaluatePixel(s){
  var water=(s.VV<${threshLinear})?1:0;
  return {data:[water],dataMask:[s.dataMask]};
}`;
}

/** Normalized-difference index definitions for the Statistical API. */
const INDEX_BANDS: Record<string, [string, string]> = {
  NDVI: ["B08", "B04"], // (NIR - Red)/(NIR + Red)
  NDWI: ["B03", "B08"], // (Green - NIR)/(Green + NIR)
  NBR: ["B08", "B12"], // (NIR - SWIR)/(NIR + SWIR)
};

export const INDEX_NAMES = Object.keys(INDEX_BANDS);

/**
 * The Sentinel-2 Scene Classification (SCL) classes excluded from index statistics, kept
 * here as the SINGLE source of truth so the evalscript mask and the human-readable
 * provenance description (src/provenance.ts) can never drift apart.
 *   - `always` is masked for every index (defective, shadow, cloud, cirrus),
 *   - `waterForNonWater` (open water, class 6) is additionally masked for vegetation/burn
 *     indices so seasonal river/lake level doesn't dilute the result — but NEVER for NDWI,
 *     where water is the signal.
 * Masked pixels become noDataCount, which the tool surfaces as a "% valid" quality flag.
 */
export const SCL_CLEAR_MASK = {
  always: [
    { id: 1, label: "defective" },
    { id: 3, label: "cloud shadow" },
    { id: 8, label: "cloud (medium prob.)" },
    { id: 9, label: "cloud (high prob.)" },
    { id: 10, label: "thin cirrus" },
  ],
  waterForNonWater: { id: 6, label: "open water" },
} as const;

/**
 * The s2cloudless layer of the mask (Horizon 1 "cloud handling, rung 1"). CDSE exposes the
 * s2cloudless model as two bands on sentinel-2-l2a: CLM (binary cloud mask, 160 m) and CLP
 * (cloud probability, 0–255). SCL and s2cloudless fail differently — SCL catches shadows
 * s2cloudless doesn't flag, s2cloudless catches the haze and small cumulus SCL misses — so
 * the stat mask excludes a pixel if EITHER flags it. Like SCL_CLEAR_MASK, this constant is
 * the single source of truth shared by the evalscript and the provenance description.
 */
export const S2CLOUDLESS_MASK = {
  clpCutoff: 102, // CLP ≥ 102/255 ≈ 40 % cloud probability → masked
  label: "s2cloudless cloud (CLM=1 or CLP≥40%)",
} as const;

/** Human-readable description of the per-pixel mask method (drives the provenance block). */
export const STAT_MASK_METHOD =
  "Sentinel-2 SCL + s2cloudless (CLM/CLP) per-pixel mask — a pixel is excluded if either flags it";

/**
 * The clear-pixel condition over a sample `s` — the SINGLE mask expression shared by the
 * least-cloudy stat evalscript and the temporal-median scripts, so the masks can't drift.
 * `excludeWater` additionally drops open water (vegetation/burn stats; never NDWI/renders).
 */
function clearCondition(excludeWater: boolean): string {
  const ids: number[] = SCL_CLEAR_MASK.always.map((c) => c.id);
  if (excludeWater) ids.push(SCL_CLEAR_MASK.waterForNonWater.id);
  const scl = ids.map((id) => `s.SCL!==${id}`).join(" && ");
  return `${scl} && s.CLM!==1 && s.CLP<${S2CLOUDLESS_MASK.clpCutoff}`;
}

/** The human-readable masked-class labels for a given mask variant. */
export function maskedClassLabels(excludeWater: boolean): string[] {
  const labels = SCL_CLEAR_MASK.always.map((c) => `${c.label} (SCL ${c.id})`);
  if (excludeWater) {
    const w = SCL_CLEAR_MASK.waterForNonWater;
    labels.push(`${w.label} (SCL ${w.id})`);
  }
  labels.push(S2CLOUDLESS_MASK.label);
  return labels;
}

/** The human-readable classes masked for a given index (drives the provenance block). */
export function maskedClassesFor(index: string): string[] {
  return maskedClassLabels(index !== "NDWI");
}

/** Build a FLOAT32 + dataMask stat evalscript for a normalized-difference index. */
export function statEvalscript(index: string): string {
  const pair = INDEX_BANDS[index];
  if (!pair) throw new Error(`unknown index '${index}'. Options: ${INDEX_NAMES.join(", ")}`);
  const [a, b] = pair;
  const clear = clearCondition(index !== "NDWI");
  return `//VERSION=3
function setup(){return {input:[{bands:["${a}","${b}","SCL","CLM","CLP","dataMask"]}],output:[{id:"data",bands:1,sampleType:"FLOAT32"},{id:"dataMask",bands:1}]}}
function evaluatePixel(s){
  var v=(s.${a}-s.${b})/(s.${a}+s.${b});
  var clear=(${clear})?1:0;
  return {data:[v],dataMask:[s.dataMask*clear]};
}`;
}

// ---------------------------------------------------------------------------------------
// Temporal-median compositing (Horizon 1 #4). `mosaicking: "ORBIT"` hands evaluatePixel
// EVERY acquisition in the window as a samples array; the per-pixel median of the
// masked-clear samples kills residual cloud/haze/shadow that scene-level least-cloudy
// selection lets through — the classic robust baseline for change detection. Costs more
// processing units than leastCC (every orbit is processed), so it's opt-in per tool call.
// ---------------------------------------------------------------------------------------

const MEDIAN_JS = `function median(v){v.sort(function(a,b){return a-b});var m=v.length>>1;return v.length%2?v[m]:(v[m-1]+v[m])/2}`;

/**
 * Per-band median RGB composites for the Process API. The clear mask (SCL + s2cloudless,
 * water KEPT — water belongs in imagery) selects which samples feed the median; a pixel
 * with zero clear observations falls back to the median of all its samples rather than a
 * black hole.
 */
export function medianRenderEvalscript(view: string): string {
  const clear = clearCondition(false);
  if (view === "ndvi") {
    return `//VERSION=3
function setup(){return {input:[{bands:["B04","B08","SCL","CLM","CLP","dataMask"]}],output:{bands:3},mosaicking:"ORBIT"}}
${MEDIAN_JS}
function evaluatePixel(samples){
  var v=[],vu=[];
  for(var i=0;i<samples.length;i++){var s=samples[i];
    if(s.dataMask!==1) continue;
    var n0=(s.B08-s.B04)/(s.B08+s.B04);
    vu.push(n0);
    if(${clear}) v.push(n0);
  }
  if(v.length===0) v=vu;
  if(v.length===0) return [0,0,0];
  var n=median(v);
  ${NDVI_RAMP_JS}
}`;
  }
  const rgb: Record<string, [string, string, string]> = {
    trueColor: ["B04", "B03", "B02"],
    falseColor: ["B08", "B04", "B03"],
  };
  const chans = rgb[view];
  if (!chans) throw new Error(`unknown view '${view}'. Options: ${Object.keys(RENDER_EVALSCRIPTS).join(", ")}`);
  const bands = [...chans].sort();
  return `//VERSION=3
function setup(){return {input:[{bands:[${bands.map((b) => `"${b}"`).join(",")},"SCL","CLM","CLP","dataMask"]}],output:{bands:3},mosaicking:"ORBIT"}}
${MEDIAN_JS}
function evaluatePixel(samples){
  var c={${bands.map((b) => `${b}:[]`).join(",")}},u={${bands.map((b) => `${b}:[]`).join(",")}};
  for(var i=0;i<samples.length;i++){var s=samples[i];
    if(s.dataMask!==1) continue;
    ${bands.map((b) => `u.${b}.push(s.${b});`).join("")}
    if(${clear}){${bands.map((b) => `c.${b}.push(s.${b});`).join("")}}
  }
  if(c.${bands[0]}.length===0) c=u;
  if(c.${bands[0]}.length===0) return [0,0,0];
  return [2.5*median(c.${chans[0]}),2.5*median(c.${chans[1]}),2.5*median(c.${chans[2]})];
}`;
}

/**
 * Temporal-median stat evalscript for the Statistical API: the per-pixel median of the
 * index over all CLEAR observations in the window (same SCL + s2cloudless mask as
 * `statEvalscript`, same NDWI-keeps-water rule). dataMask=0 where a pixel has no clear
 * observation, so validPct reads "% of pixels with ≥1 clear observation".
 */
export function medianStatEvalscript(index: string): string {
  const pair = INDEX_BANDS[index];
  if (!pair) throw new Error(`unknown index '${index}'. Options: ${INDEX_NAMES.join(", ")}`);
  const [a, b] = pair;
  const clear = clearCondition(index !== "NDWI");
  return `//VERSION=3
function setup(){return {input:[{bands:["${a}","${b}","SCL","CLM","CLP","dataMask"]}],output:[{id:"data",bands:1,sampleType:"FLOAT32"},{id:"dataMask",bands:1}],mosaicking:"ORBIT"}}
${MEDIAN_JS}
function evaluatePixel(samples){
  var vals=[];
  for(var i=0;i<samples.length;i++){var s=samples[i];
    if(s.dataMask===1 && (${clear})) vals.push((s.${a}-s.${b})/(s.${a}+s.${b}));
  }
  if(vals.length===0) return {data:[0],dataMask:[0]};
  return {data:[median(vals)],dataMask:[1]};
}`;
}
