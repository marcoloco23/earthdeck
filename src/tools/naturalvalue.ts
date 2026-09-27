import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { geocode } from "../clients/geo.js";
import {
  BIOME_IDS,
  BIOMES,
  CLEARED_COMPARATOR,
  GLOBAL_NATURE_VALUE,
  annuityFactor,
  LAND_COVER,
  ORGANISMS,
  SERVICE_LABEL,
  assumeBiome,
  fetchGeeLandCover,
  fetchLandCoverMix,
  geeDatasetsFor,
  geeStatus,
  valueMix,
  type BiomeId,
  type BiomeShare,
  type GeeLandCover,
} from "../clients/naturalvalue.js";
import { pushCard } from "../dashboard/push.js";
import { OverviewError } from "../errors.js";
import { safe } from "../result.js";
import type { BBox } from "../types.js";
import { round } from "../series.js";
import { assertBBox, bboxCenter, newId, nowIso } from "../util.js";
import { bboxAreaKm2 } from "./biodiversity.js";

const MAX_AREA_KM2 = 250_000; // a benefit-transfer sum over a subcontinent means nothing

/** Compact USD for humans: $1.2M, $3.4B, $5.6T. */
export function usd(v: number): string {
  const a = Math.abs(v);
  const [d, s] = a >= 1e12 ? [1e12, "T"] : a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : a >= 1e3 ? [1e3, "k"] : [1, ""];
  const x = v / d;
  return `$${x >= 100 || s === "" ? Math.round(x).toLocaleString("en-US") : x.toFixed(x >= 10 ? 0 : 1)}${s}`;
}

/** Register natural_value — what an area's ecosystems are worth per year *alive* (benefit transfer). */
export function registerNaturalValueTools(server: McpServer): void {
  server.registerTool(
    "natural_value",
    {
      title: "Natural value — what this place is worth alive",
      description:
        "Order-of-magnitude value of the work an area's living ecosystems do every year — climate " +
        "and water regulation, erosion control, food and raw materials, habitat, recreation — so " +
        "'alive' has a number next to 'cleared'. For a bbox or place: land-cover mix — with Earth " +
        "Engine configured, land USE from MapBiomas (Brazil, separates pasture from grassland) or " +
        "Dynamic World (elsewhere), valuing natural land only and reporting converted ha separately; " +
        "else CLMS 10 m global land cover 2020 via Copernicus Data Space (CDSE creds); else a stated " +
        "latitude assumption or the `biome` you pass — area by biome, annual living " +
        "value (low/mid/high, 2020 USD), the value over a horizon (undiscounted and NPV), a " +
        "per-service breakdown, per-organism reference values (whale, elephant, tree) and a method " +
        "block with blind spots. BENEFIT TRANSFER from global per-biome unit values (Costanza et al. " +
        "2014 / de Groot et al. 2012) — not a local valuation and not a price for sale. Posts a card.",
      inputSchema: {
        bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe("Bounding box [west, south, east, north] in degrees."),
        place: z.string().min(1).optional().describe("Place name, resolved via OpenStreetMap (used when bbox is omitted)."),
        horizonYears: z.number().int().min(1).max(500).optional().describe("Horizon for the long-run value (default 100 years)."),
        discountRate: z.number().min(0).max(0.1).optional().describe("Annual discount rate for the NPV (default 0.02 = 2 %)."),
        landCover: z.enum(["worldcover", "assume"]).optional().describe("'worldcover' (default): measure the class mix; 'assume': skip the raster and use `biome` or the latitude assumption."),
        biome: z.enum(BIOME_IDS as [BiomeId, ...BiomeId[]]).optional().describe(`Force one biome for the whole area (skips land cover). One of: ${BIOME_IDS.join(", ")}.`),
      },
    },
    async ({ bbox, place, horizonYears, discountRate, landCover, biome }) =>
      safe(async () => {
        const where = await resolveBBox(bbox, place);
        const areaKm2 = bboxAreaKm2(where.bbox);
        if (areaKm2 > MAX_AREA_KM2) throw new OverviewError(`area is ${Math.round(areaKm2).toLocaleString("en-US")} km² — keep it under ${MAX_AREA_KM2.toLocaleString("en-US")} km² (benefit transfer over a subcontinent is not meaningful).`);
        const areaHa = areaKm2 * 100;
        const years = horizonYears ?? 100;
        const rate = discountRate ?? 0.02;

        let mix: BiomeShare[];
        let landCoverUsed: Record<string, unknown>;
        const assumptions: string[] = [];
        let geeLc: GeeLandCover | undefined;
        if (biome) {
          mix = [{ biome, share: 1 }];
          landCoverUsed = { provider: "user", source: "user", note: `whole area treated as ${BIOMES[biome].label} (biome given)` };
        } else if (landCover === "assume") {
          const a = assumeBiome(bboxCenter(where.bbox)[1]);
          mix = [{ biome: a.biome, share: 1 }];
          assumptions.push(a.assumption);
          landCoverUsed = { provider: "assumed", source: "assumption", note: a.assumption };
        } else {
          // Earth Engine land USE first (MapBiomas in Brazil, else Dynamic World) — only when configured.
          const fallbacks: string[] = [];
          const gee = geeStatus();
          if (typeof gee === "string") fallbacks.push(`earth engine: ${gee.slice(0, 160)}`);
          if (gee === true) {
            for (const ds of geeDatasetsFor(where.bbox)) {
              try {
                geeLc = await fetchGeeLandCover(where.bbox, ds);
                break;
              } catch (err) {
                fallbacks.push(`${ds}: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`);
              }
            }
          }
          const fb = fallbacks.length ? { fallbacks } : {};
          if (geeLc) {
            mix = geeLc.mix;
            const { mix: _m, convertedReferenceMix: _r, ...rest } = geeLc;
            landCoverUsed = { ...rest, ...fb };
          } else {
            try {
              const lc = await fetchLandCoverMix(where.bbox);
              mix = lc.mix;
              landCoverUsed = {
                provider: "clms-cdse",
                ...fb,
                source: LAND_COVER.name,
                licence: LAND_COVER.licence,
                doi: LAND_COVER.doi,
                legend: "ESA WorldCover's 11 LCCS classes, but numbered differently (e.g. 50 = herbaceous wetland, 90 = built-up, 100 = water)",
                pixels: lc.pixels,
                classes: lc.classes,
              };
            } catch (err) {
              const a = assumeBiome(bboxCenter(where.bbox)[1]);
              mix = [{ biome: a.biome, share: 1 }];
              const why = err instanceof Error ? err.message : String(err);
              assumptions.push(`land cover unavailable (${why.slice(0, 160)}) — ${a.assumption}`);
              landCoverUsed = { provider: "assumed", ...fb, source: "assumption", note: assumptions.at(-1) };
            }
          }
        }

        const v = valueMix(mix, areaHa, years, rate);
        // "Alive vs cleared" — only where a sourced comparator exists (tropical forest, Pará).
        const tf = BIOMES.tropical_forest.usdPerHaYr;
        const cleared = mix.some((m) => m.biome === CLEARED_COMPARATOR.biome)
          ? {
              line:
                `A hectare of tropical forest here does ~$${tf.mid.toLocaleString("en-US")}/yr of work alive (band $${tf.low.toLocaleString("en-US")}–$${tf.high.toLocaleString("en-US")}), ` +
                `every year — vs ~$${CLEARED_COMPARATOR.usdPerHaOnce.low.toLocaleString("en-US")}–$${CLEARED_COMPARATOR.usdPerHaOnce.high.toLocaleString("en-US")} once as cleared land (southern Pará, ${CLEARED_COMPARATOR.dollarYear}).`,
              ...CLEARED_COMPARATOR,
            }
          : null;
        // Converted land (Earth Engine providers only): reported, never in the living value.
        const converted = geeLc
          ? {
              ha: geeLc.convertedHa,
              sharePct: round((geeLc.convertedHa / areaHa) * 100, 1),
              byClass: geeLc.classes.filter((c) => c.use === "converted").map((c) => ({ code: c.code, name: c.name, ha: c.ha, sharePct: c.sharePct, basis: c.basis })),
              referenceAnnualUsd: valueMix(geeLc.convertedReferenceMix, areaHa).annualUsd,
              referenceNote:
                "Costanza et al. 2014 cropland / urban unit values for the converted classes that have one — a reference, NOT included in annualUsd. " +
                "Pasture, mosaic, plantation, mining and bare land have no sourced unit value and are 0.",
            }
          : null;
        const top = [...v.byBiome].sort((a, b) => b.annualUsd.mid - a.annualUsd.mid)[0];
        const summary =
          `${Math.round(areaHa).toLocaleString("en-US")} ha${where.place ? ` around ${where.place.split(",")[0]}` : ""}: ` +
          `living ecosystems worth ~${usd(v.annualUsd.mid)}/yr (band ${usd(v.annualUsd.low)}–${usd(v.annualUsd.high)}), ` +
          `~${usd(v.horizon.undiscountedUsd.mid)} over ${years} yr undiscounted or ${usd(v.horizon.npvUsd.mid)} NPV at ${(rate * 100).toFixed(1)} %` +
          (top ? `; largest share ${BIOMES[top.biome].label} (${Math.round(top.sharePct)} %)` : "") +
          (converted ? `; ${converted.ha.toLocaleString("en-US")} ha (${converted.sharePct} %) is converted land (mostly ${converted.byClass[0]?.name ?? "n/a"}) and is not valued` : "") +
          `. Benefit transfer, order of magnitude — not a price for sale.`;

        const pushed = await pushCard({
          id: newId(),
          type: "pulse",
          ts: nowIso(),
          title: `Natural value${where.place ? ` · ${where.place.split(",")[0]}` : ""} · ~${usd(v.annualUsd.mid)}/yr alive`,
          bbox: where.bbox,
          payload: {
            metrics: [
              { label: "Alive, per year", value: usd(v.annualUsd.mid), sub: `${usd(v.annualUsd.low)}–${usd(v.annualUsd.high)} · 2020 USD` },
              { label: `${years} yr (undiscounted)`, value: usd(v.horizon.undiscountedUsd.mid) },
              { label: `${years} yr NPV @ ${(rate * 100).toFixed(1)} %`, value: usd(v.horizon.npvUsd.mid) },
              { label: "Area", value: `${Math.round(areaHa).toLocaleString("en-US")} ha` },
              ...(converted ? [{ label: "Converted (not valued)", value: `${converted.ha.toLocaleString("en-US")} ha`, sub: `${converted.sharePct} % · ${String(landCoverUsed.provider)}` }] : []),
              ...v.byBiome.slice(0, 4).map((b) => ({ label: BIOMES[b.biome].label, value: `${Math.round(b.sharePct)} %`, sub: `${usd(b.annualUsd.mid)}/yr` })),
              ...v.services.slice(0, 3).map((s) => ({ label: SERVICE_LABEL[s.service], value: `${usd(s.annualUsd)}/yr` })),
            ],
            summary,
            source: "Costanza et al. 2014 / de Groot et al. 2012 unit values (benefit transfer); land cover: " + String(landCoverUsed.source),
          },
        });

        return {
          area: { bbox: where.bbox, place: where.place ?? null, ha: Math.round(areaHa) },
          landCover: landCoverUsed,
          byBiome: v.byBiome,
          annualUsd: v.annualUsd,
          horizon: {
            ...v.horizon,
            sensitivity: [0, 0.014, 0.02, 0.03, 0.07].map((r) => ({ discountRate: r, npvUsdMid: Math.round(v.annualUsd.mid * annuityFactor(years, r)) })),
          },
          ...(converted ? { converted } : {}),
          ...(cleared ? { clearedComparator: cleared } : {}),
          services: v.services,
          summary,
          references: {
            organisms: ORGANISMS,
            globalNatureValue: GLOBAL_NATURE_VALUE,
          },
          method: {
            unit: "2020 US dollars",
            formula:
              (geeLc ? "annual = Σ over NATURAL land-cover classes only (converted land = 0) of " : "annual = Σ_biome ") +
              "area_ha × unit value (USD/ha/yr, low/mid/high); horizon undiscounted = annual × T; " +
              "NPV = annual × (1 − (1+r)^−T) / r (flows at year-end, constant real value)",
            transfer: "benefit transfer: global per-biome mean unit values (Costanza et al. 2014, Table 2; de Groot et al. 2012) moved to this place without local calibration; 2007 → 2020 USD via US CPI-U",
            band: "low/high = the per-biome band stated in the registry entry (see byBiome[].source); treat the mid as an order of magnitude",
            discountRate:
              `${rate} — a low social rate because these are life-support flows to future people, not a private investment. ` +
              "The Stern Review used ~1.4 %; the Nov 2023 US OMB Circular A-4 used 2.0 % (rescinded in 2025 by OMB M-25-15, which reinstated 3 % / 7 %). " +
              "Over 100 years a constant flow is worth 100× annual undiscounted, ~53.6× at 1.4 %, ~43.1× at 2 %, ~31.6× at 3 %, ~14.3× at 7 % — see horizon.sensitivity.",
            assumptions,
            blindSpots: [
              "Benefit transfer: a global average hectare of 'tropical forest' is not this hectare — no local calibration, condition, degradation or fragmentation is accounted for.",
              "The unit values are means of a skewed literature (few studies, many regions missing); the true local value can be an order of magnitude off either way.",
              ...(geeLc ? geeBlindSpots(geeLc) : CLMS_BLIND_SPOTS),
              "Plural values are not captured: sacred, relational and intrinsic values (IPBES 2022) and Indigenous stewardship have no dollar column here — the number is a floor for one kind of value, not the worth of the place.",
              "Distribution: who benefits (downstream towns, the global climate) is not who pays or who owns the land; the total hides that.",
              "Not a market price: nobody will pay this for the land, and clearing does not remove all of it at once (some services persist, some are lost for decades).",
              "Double counting between services and between biomes, and non-linear effects (tipping points), are not modelled.",
            ],
          },
          dashboard: pushed ? "card pushed" : "dashboard not running",
        };
      }),
  );
}

const CLMS_BLIND_SPOTS = [
  "Land cover is a 2020 snapshot at 10 m sampled at ≤256 px; recent clearing, cloud-era errors and mixed pixels shift the mix. Water is valued as lakes/rivers even where it is sea.",
  "Pasture is not grassland: the land-cover map cannot tell cattle pasture on cleared forest from natural grassland, and both get Costanza's grass/rangeland value (~$5,200/ha/yr) — in deforestation frontiers this overstates the 'alive' total and understates the gap between forest and cleared land.",
];

/** Honest limits of the Earth Engine land-use providers. */
function geeBlindSpots(lc: GeeLandCover): string[] {
  const common =
    "Converted land (pasture, crops, mosaic, urban, mining, bare) counts 0 in the living value — it still does some ecosystem work (a degraded pasture stores some carbon and water), so the total is a floor, not the loss if the rest were cleared. " +
    "Savanna, shrub and other natural non-forest vegetation get Costanza's grass/rangeland value; water is valued as lakes/rivers even where it is sea.";
  if (lc.provider === "mapbiomas-ee") {
    return [
      `Land use is MapBiomas Brazil Collection 10 for ${lc.year} (annual, 30 m, computed at ${lc.scaleM} m): it lags today by the year(s) since ${lc.year}, so clearing since then is not in the mix. MapBiomas' own accuracy varies by biome and class (pasture vs. natural grassland is hardest in the Cerrado/Pampa).`,
      common,
    ];
  }
  return [
    `Land cover is Dynamic World V1, the per-pixel MODE of near-real-time labels over ${lc.window?.from}…${lc.window?.to} (computed at ${lc.scaleM} m). Dynamic World is probabilistic — each label is a model's most likely class, so label noise, cloud gaps and seasonal flooding shift the mix.`,
    "Dynamic World's 'grass' class includes pasture, parks and lawns as well as natural grassland, and 'trees' includes plantations and orchards — outside Brazil, pasture on cleared forest is still valued as grassland (~$5,200/ha/yr). Only crops, built-up and bare land are counted as converted.",
    common,
  ];
}

async function resolveBBox(bbox: number[] | undefined, place: string | undefined): Promise<{ bbox: BBox; place?: string }> {
  if (bbox) {
    assertBBox(bbox as BBox);
    return { bbox: bbox as BBox };
  }
  if (place) {
    const g = await geocode(place);
    return { bbox: g.bbox, place: g.displayName };
  }
  throw new OverviewError("pass a bbox [west, south, east, north] or a place name");
}
