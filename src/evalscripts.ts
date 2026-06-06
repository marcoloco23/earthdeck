// Sentinel Hub evalscripts. Render scripts return an RGB visualization; stat scripts
// return a single FLOAT32 index band + dataMask for the Statistical API.

/** Visualization evalscripts for the Process API (eo_render `view`). */
export const RENDER_EVALSCRIPTS: Record<string, string> = {
  trueColor: `//VERSION=3
function setup(){return {input:["B02","B03","B04"],output:{bands:3}}}
function evaluatePixel(s){return [2.5*s.B04,2.5*s.B03,2.5*s.B02]}`,

  // Color-infrared: vegetation bright red (B08 NIR → red channel).
  falseColor: `//VERSION=3
function setup(){return {input:["B03","B04","B08"],output:{bands:3}}}
function evaluatePixel(s){return [2.5*s.B08,2.5*s.B04,2.5*s.B03]}`,

  // NDVI color ramp: blue water → tan bare → greens for increasing vegetation.
  ndvi: `//VERSION=3
function setup(){return {input:["B04","B08"],output:{bands:3}}}
function evaluatePixel(s){
  var n=(s.B08-s.B04)/(s.B08+s.B04);
  if(n<-0.2) return [0.05,0.05,0.4];
  if(n<0.0) return [0.6,0.6,0.6];
  if(n<0.2) return [0.85,0.8,0.55];
  if(n<0.4) return [0.74,0.83,0.38];
  if(n<0.6) return [0.42,0.72,0.22];
  return [0.1,0.5,0.05];
}`,
};

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

/** The human-readable SCL classes masked for a given index (drives the provenance block). */
export function maskedClassesFor(index: string): string[] {
  const labels = SCL_CLEAR_MASK.always.map((c) => `${c.label} (SCL ${c.id})`);
  if (index !== "NDWI") {
    const w = SCL_CLEAR_MASK.waterForNonWater;
    labels.push(`${w.label} (SCL ${w.id})`);
  }
  return labels;
}

/** Build a FLOAT32 + dataMask stat evalscript for a normalized-difference index. */
export function statEvalscript(index: string): string {
  const pair = INDEX_BANDS[index];
  if (!pair) throw new Error(`unknown index '${index}'. Options: ${INDEX_NAMES.join(", ")}`);
  const [a, b] = pair;
  const ids: number[] = SCL_CLEAR_MASK.always.map((c) => c.id);
  if (index !== "NDWI") ids.push(SCL_CLEAR_MASK.waterForNonWater.id);
  const clear = ids.map((id) => `s.SCL!==${id}`).join(" && ");
  return `//VERSION=3
function setup(){return {input:[{bands:["${a}","${b}","SCL","dataMask"]}],output:[{id:"data",bands:1,sampleType:"FLOAT32"},{id:"dataMask",bands:1}]}}
function evaluatePixel(s){
  var v=(s.${a}-s.${b})/(s.${a}+s.${b});
  var clear=(${clear})?1:0;
  return {data:[v],dataMask:[s.dataMask*clear]};
}`;
}
