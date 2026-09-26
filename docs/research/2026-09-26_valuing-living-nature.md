# What nature is worth alive: evidence base for `natural_value`

`natural_value` can put an honest, sourced, order-of-magnitude "worth alive" number beside "cleared" if it does four things. It transfers published per-biome unit values: Costanza et al. 2014 for the mid value, and the de Groot et al. 2012 min/median/max for the band. It weights them by the ESA WorldCover class mix of the area, converts them to 2020 USD with one stated CPI factor, and reports an annual flow, a 100-year undiscounted sum and a 2% NPV. It always shows the ±1 order-of-magnitude band and the caveats alongside the number. The literature supports doing this. Costanza's own paper says such numbers "are useful to highlight the magnitude of eco-services, but have no specific decision-making context" and that valuing a service "is not the same as commodification or privatization" ([Costanza et al. 2014](https://www.robertcostanza.com/wp-content/uploads/2017/02/2014_J_Costanza_GlobalValueUpdate.pdf)). The honest framing is therefore awareness and comparison, not a price.

Three limits apply to this document. Every number below carries its source. Figures marked **UNCONFIRMED** could not be checked against a primary or fetched text. Tables marked "fetched" were extracted from the PDF itself.

## The per-biome unit values: Costanza 2014 and de Groot 2012

Costanza et al. 1997 put the global value of ecosystem services at $33 trillion/yr in 1995 US$ ($46T/yr in 2007 US$). The 2014 update gives **$125T/yr** (updated unit values and 2011 biome areas) or **$145T/yr** (unit values only), both in 2007 US$. It estimates the loss from land-use change between 1997 and 2011 at **$4.3–20.2T/yr** ([Costanza et al. 2014, *Global Environmental Change* 26:152–158](https://www.robertcostanza.com/wp-content/uploads/2017/02/2014_J_Costanza_GlobalValueUpdate.pdf), abstract and Table 3). For comparison, global GDP was $75.2T/yr in 2011 (2007$), per the same paper.

**Table A: Costanza et al. 2014, Table 3 unit values (2007 $/ha/yr; fetched from the PDF)**

| Biome | 1997 value | 2011 value (use this) | 2011 → 2020 USD (×1.24823) |
|---|---:|---:|---:|
| Open ocean | 348 | 660 | 824 |
| Coastal (aggregate) | 5,592 | 8,944 | 11,164 |
| Estuaries | 31,509 | 28,916 | 36,094 |
| Seagrass/algae beds | 26,226 | 28,916 | 36,094 |
| Coral reefs | 8,384 | 352,249 | 439,689 |
| Shelf | 2,222 | 2,222 | 2,774 |
| Tropical forest | 2,769 | 5,382 | 6,718 |
| Temperate/boreal forest | 417 | 3,137 | 3,916 |
| Grass/rangelands | 321 | 4,166 | 5,200 |
| Tidal marsh/mangroves | 13,786 | 193,843 | 241,961 |
| Swamps/floodplains | 27,021 | 25,681 | 32,056 |
| Lakes/rivers | 11,727 | 12,512 | 15,618 |
| Cropland | 126 | 5,567 | 6,949 |
| Urban | – | 6,661 | 8,314 |
| Desert, tundra, ice/rock | – | – (not valued) | 0 |

The 2011 unit values come from de Groot et al. 2012, which coded about 1,350 estimates from more than 300 case-study locations and used 665 of them. Values are in 2007 **international** dollars (PPP), and the paper states "1 Int.$ = 1 USD" ([de Groot et al. 2012, *Ecosystem Services* 1:50–61](https://www.es-partnership.org/wp-content/uploads/2020/08/2012-De-Groot-et-al-Global-Estimates.pdf)). Its Table 3 supplies the ranges that make an honest band possible.

**Table B: de Groot et al. 2012, Table 3 (Int$/ha/yr, 2007 price levels; fetched)**

| Biome | n | Mean (TEV) | SD | Median | Min | Max |
|---|---:|---:|---:|---:|---:|---:|
| Open oceans | 14 | 491 | 762 | 135 | 85 | 1,664 |
| Coral reefs | 94 | 352,915 | 668,639 | 197,900 | 36,794 | 2,129,122 |
| Coastal systems | 28 | 28,917 | 5,045 | 26,760 | 26,167 | 42,063 |
| Coastal wetlands (mangroves/tidal marsh) | 139 | 193,845 | 384,192 | 12,163 | 300 | 887,828 |
| Inland wetlands | 168 | 25,682 | 36,585 | 16,534 | 3,018 | 104,924 |
| Rivers and lakes | 15 | 4,267 | 2,771 | 3,938 | 1,446 | 7,757 |
| Tropical forest | 96 | 5,264 | 6,526 | 2,355 | 1,581 | 20,851 |
| Temperate forest | 58 | 3,013 | 5,437 | 1,127 | 278 | 16,406 |
| Woodlands | 21 | 1,588 | 317 | 1,522 | 1,373 | 2,188 |
| Grasslands | 32 | 2,871 | 3,860 | 2,698 | 124 | 5,930 |

Two cautions follow from Table B. First, the medians sit far below the means: for mangroves the median is 12,163 against a mean of 193,845. The distributions are heavily right-skewed, and the paper itself says a median "might be appropriate". Second, the paper warns that "for most biomes less than half of the total number of services is represented", so the values are "almost certainly an under-estimate".

**Service split (de Groot 2012 Table 2, Int$/ha/yr 2007; fetched).** Totals are the provisioning, regulating, habitat and cultural subtotals in that order.

- **Tropical forest (total 5,264):** 1,828 / 2,529 / 39 / 867. Climate regulation contributes 2,044, of which food is 200, raw materials 84, water 27, genetic resources 13, erosion prevention 15 and recreation 867.
- **Temperate forest (total 3,013):** 671 / 491 / 862 / 990.
- **Coral reefs (total 352,249):** 55,724 / 171,478 / 16,210 / 108,837. Erosion prevention contributes 153,214 and recreation 96,302. The paper notes that the recreation figure ranges from "a little more than 0.1" to "more than 1 million" Int$/ha/yr.
- **Coastal wetlands (total 193,845):** 2,998 / 171,515 / 17,138 / 2,193. Waste treatment contributes 162,125.
- **Inland wetlands (total 25,682):** 1,659 / 17,364 / 2,455 / 4,203.
- **Grasslands (total 2,871):** 1,305 / 159 / 1,214 / 193.
- **Rivers/lakes (total 4,267):** 1,914 / 187 / 0 / 2,166.
- **Open ocean (total 491):** 102 / 65 / 5 / 319.

## The modern successor: ESVD 2020-dollar synthesis (Brander et al. 2024)

The Ecosystem Services Valuation Database now holds "over 9,400 value estimates" from "over 1,300 studies". Values are standardised to **Int$/ha/yr at 2020 price levels** across 15 biomes and 23 services ([Brander et al. 2024, *Ecosystem Services* 66:101606](https://zenodo.org/records/16041479), CC BY 4.0). The ESVD web interface launched in 2020 "to provide free and convenient access", and it is "possible to download the search query results or the entire database as a csv file" ([esvd.net](https://www.esvd.net/)). The ESVD's own terms of use, including whether registration is required and whether commercial reuse is allowed, could not be retrieved because the site renders client-side. **UNCONFIRMED**: treat the database as registration-gated with unknown redistribution terms until those terms are read. The *paper's* summary table is CC BY 4.0 and safe to embed with attribution.

**Table C: Brander et al. 2024, Table 1 "Sum" row (mean Int$ 2020/ha/yr, single-service/single-biome primary estimates, outliers removed; fetched)**

| Biome | Sum |
|---|---:|
| Marine | 2,434 |
| Coral reefs | 87,211 |
| Coastal systems | 36,026 |
| Mangroves | 77,928 |
| Inland wetlands | 34,018 |
| Rivers and lakes | 33,447 |
| Tropical & subtropical forests | 8,166 |
| Temperate forest & woodland | 15,570 |
| Boreal & montane forests | 5,559 |
| Shrubland & shrubby woodland | 728 |
| Rangeland, natural grasslands & savannas | 5,934 |
| Polar-alpine | 1,769 |
| Intensive land uses | 17,360 |
| Urban & industrial | 64,167 |

The authors caution that summing means across services is crude. The data over-represent Europe, which holds 32% of estimates, and the table is "not globally representative". Even so, the tropical forest figure (8,166 in 2020 Int$) sits within about 20% of the CPI-converted Costanza 2011 figure (6,718). That agreement is a useful sanity check for v1.

**Frameworks around the numbers:**

- **UN SEEA Ecosystem Accounting** was adopted by the UN Statistical Commission at its 52nd session in March 2021. It chains ecosystem extent, condition, service flows and monetary asset value ([SEEA](https://seea.un.org/ecosystem-accounting)).
- **UK ONS natural capital accounts** (5 Dec 2025, 2024 prices, OGL v3.0) show the approach in practice: a UK asset value of **£1.6T** for 2023 and annual ecosystem services of **£41bn**. Recreation-health accounts for £508bn of the asset value ([ONS 2025](https://www.ons.gov.uk/economy/environmentalaccounts/bulletins/uknaturalcapitalaccounts/2025)).
- **InVEST** (Natural Capital Project) is the spatial-model alternative to benefit transfer, licensed under Apache-2.0 ([github.com/natcap/invest](https://github.com/natcap/invest)).
- **TEEB** (2010) fed the de Groot database. No TEEB figure is used here.

## Charismatic units: whale, elephant, tree, reef

- **Great whale.** Chami et al. (IMF *F&D*, Dec 2019) estimate the average great whale at "more than $2 million", and "easily over $1 trillion for the current stock". Each great whale "sequesters 33 tons of CO2 on average". The population is "slightly more than 1.3 million today" against 4–5 million before whaling. The method discounts lifetime carbon at market prices and adds fishery enhancement and ecotourism ([IMF eLibrary](https://www.elibrary.imf.org/view/journals/022/0056/004/article-A011-en.xml)).
- **Forest elephant.** Chami, Fullenkamp, Cosimano and Berzaghi (IMF *F&D*, Dec 2020, from an Aug 2020 working paper) value each African forest elephant's carbon-capture services at more than **$1.75M**. The 100,000 remaining elephants have a present value of **over $176bn**, or $1.76M each, rising to $375bn ($3.75M each) if poaching ended ([AWI summary](https://awionline.org/awi-quarterly/winter-2020/forest-elephant-conservation-has-high-economic-value); [IMF F&D](https://www.imf.org/en/publications/fandd/issues/2020/09/how-african-elephants-fight-climate-change-ralph-chami)). The carbon price of about $25/t (2019) comes from a search snippet and is **UNCONFIRMED**; the IMF pages returned 403.
- **Street tree.** McPherson, van Doorn and de Goede (2016, *Urban Forestry & Urban Greening*; i-Tree) find that California's 9.1M street trees yield **$1.0bn/yr, or $110.63 per tree per year**. Management costs $19.00 per tree per year, a benefit-cost ratio of $5.82 per $1 ([USDA Treesearch 50951](https://research.fs.usda.gov/treesearch/50951)). Aesthetic and property value dominates at $838.94M. A structural or asset value of $2.49bn appears in a fetched summary but is **UNCONFIRMED**.
- **Coral reef flood protection.** Beck et al. (2018, *Nature Communications* 9:2186) find that reefs avert $4.3bn/yr in flood damage worldwide. Losing 1 m of reef height would raise expected annual damages from $3.7bn to $8bn ([Nature Comms](https://www.nature.com/articles/s41467-018-04568-z); [Pew summary](https://www.pew.org/en/research-and-analysis/articles/2018/06/20/coral-reefs-prevent-4-3-billion-in-flood-damage-annually)).

Units matter for these cards. A tree measured in $/tree/yr is not a hectare in $/ha/yr, and the whale and elephant figures are carbon-dominated present values, not annual flows. They belong in the tool as labelled *illustrative anchors*, never summed with the biome transfer.

## Downstream people: how mining damage gets priced

- **Mariana/Fundão (dam collapse 5 Nov 2015).** Vale, BHP and Samarco signed a definitive settlement on 25 Oct 2024 of **about R$170bn**. It comprises R$100bn over 20 years to governments, R$32bn in Samarco performance obligations and R$38bn already spent ([Vale](https://vale.com/w/definitive-settlement-mariana)). A US$31.7bn equivalent appears in Vale's 6-K ([SEC 6-K, Oct 2024](https://www.sec.gov/Archives/edgar/data/917851/000129281424003801/vale20241018_6k.htm); taken from a search snippet).
- **Brumadinho (2019).** The global settlement of 4 Feb 2021 was worth about **R$37.7bn**, roughly US$7bn ([MercoPress](https://en.mercopress.com/2021/02/05/mining-giant-vale-signs-us-7bn-settlement-deal-over-brumadinho-disaster-that-killed-more-than-270-people); [Vale 6-K](https://www.sec.gov/Archives/edgar/data/917851/000110465921145190/tm2131523d13_6k.htm); taken from a search snippet).
- **Artisanal gold in the Amazon.** The Conservation Strategy Fund / MPF *Calculadora de Impactos do Garimpo* (launched 9 Jun 2021) prices deforestation, river sedimentation and mercury damage. It finds that "1 kg of gold generates an estimated impact of **R$940 thousand to R$2 million**", mostly from mercury's effects on human health. For the Tapajós basin in 2020 it estimates R$5.4bn of impact, 4,547 ha deforested, 6.1Mt of sediment and 369,000 people at elevated mercury risk ([CSF](https://www.conservation-strategy.org/news/conservacao-estrategica-e-ministerio-publico-federal-lancam-calculadora-online-de-impactos-do); [calculator](https://miningcalculator.conservation-strategy.org/)). It accepts either hectares or grams of gold as input. The MPF's formal adoption (Technical Opinion 694/2021) and the more than US$9.3bn in compensation requests come from a search snippet and are **UNCONFIRMED**.

**An honest v1 proxy for "beneficiaries downstream."**

1. Find the HydroBASINS level-8 to level-12 polygon containing the area of interest.
2. Walk `NEXT_DOWN` a fixed number of steps downstream.
3. Sum population over those basins.

HydroBASINS v1c is "freely available for scientific, educational and commercial use" under the HydroSHEDS licence ([hydrosheds.org](https://www.hydrosheds.org/products/hydrobasins); cite Lehner & Grill 2013). It downloads without a key: `https://data.hydrosheds.org/file/hydrobasins/standard/hybas_sa_lev01-12_v1c.zip` returned HTTP 200 (334 MB) and honoured a range request (206). Two population sources fit. WorldPop is CC BY 4.0 ([hub.worldpop.org](https://hub.worldpop.org/geodata/listing?id=75)). GHS-POP R2023A (100 m, 1975–2030) allows reuse "provided the source is acknowledged" ([JRC](https://data.jrc.ec.europa.eu/dataset/2ff68a52-5b5b-4a22-8f40-c41da8332cfe)). Both licences come from search snippets. The GloFAS basin licence was not checked (**UNCONFIRMED**).

The output should be labelled "people living downstream within N basins": an exposure count, not a damage figure. The CSF $/kg-gold figures can be shown next to it as an external benchmark.

## Land cover: ESA WorldCover

The ESA WorldCover registry entry reads: "Global land cover maps for 2020 & 2021 at 10 m", 11 classes, **CC-BY 4.0**, bucket `arn:aws:s3:::esa-worldcover` in `eu-central-1`, managed by VITO, anonymous listing supported ([AWS registry](https://registry.opendata.aws/esa-worldcover-vito/)). The tile pattern, verified live on 2026-09-26, is:

```
https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{LAT}{LON}_Map.tif   # e.g. S09W054
https://esa-worldcover.s3.eu-central-1.amazonaws.com/v100/2020/map/ESA_WorldCover_10m_2020_v100_{LAT}{LON}_Map.tif
```

Both sample tiles answered `Range: bytes=0-1023` with **206 Partial Content**. The v200 file is 24,966,988 bytes and the v100 file 23,251,629 bytes, so COG windowed reads work. Tiles are 3°×3°, named by their south-west corner.

The class codes are:

| Code | Class |
|---:|---|
| 10 | Tree cover |
| 20 | Shrubland |
| 30 | Grassland |
| 40 | Cropland |
| 50 | Built-up |
| 60 | Bare/sparse vegetation |
| 70 | Snow and ice |
| 80 | Permanent water bodies |
| 90 | Herbaceous wetland |
| 95 | Mangroves |
| 100 | Moss and lichen |

Required attribution: "© ESA WorldCover project / Contains modified Copernicus Sentinel data (2020/2021)". A Sentinel Hub BYOC collection `byoc-0b940c63-45dd-4e6b-8019-c3660b81b884` exists on `services.sentinel-hub.com` (Planet) ([Planet docs](https://docs.planet.com/data/public-data/other-datasets/esa-worldcover/)). Whether the same ID works on CDSE's Sentinel Hub is **UNCONFIRMED**, but the AWS COGs make it unnecessary.

## The "cleared" comparator

No peer-reviewed per-hectare Pará land price could be fetched: ScienceDirect and Nature returned 403 or 303. The best sourced figure is journalistic. A regional land dealer quoted by Mongabay (Feb 2023) put cleared land in southern Pará at "**10,000–35,000 reais ($1,900–$6,800) per hectare**". That implies about R$130M ($25.5M) for 6,469 ha, or about $20M profit after roughly $2.5M of clearing costs ([Mongabay](https://news.mongabay.com/2023/02/the-20m-flip-the-story-of-the-largest-land-grab-in-the-brazilian-amazon/)). Killeen (Mongabay, 2024) gives pasture cash flow as "~$200 per hectare annually" ([Mongabay](https://news.mongabay.com/2024/01/land-in-the-pan-amazon-the-ultimate-commodity-chapter-4-of-a-perfect-storm-in-the-amazon/amp/)).

Use these only as a labelled, low-grade comparator: a **one-off $1.9–6.8k/ha** for cleared land against a **transfer mid-value of about $6.7k/ha/yr** for standing tropical forest. The asymmetry is the whole point, and the source quality should be shown alongside it.

## Critique: why show the number *and* the caveats

- **Plural values.** The IPBES Values Assessment (approved July 2022) argues that decisions based on "a narrow set of market values of nature" underpin the biodiversity crisis. It notes there are "more than 50 valuation methods" ([IPBES](https://www.ipbes.net/the-values-assessment); [media release](https://www.ipbes.net/media_release/Values_Assessment_Published)). A single dollar figure is one value type among many.
- **Commodification.** Costanza et al. 2014 explicitly deny that valuation implies privatisation.
- **Benefit-transfer error.** de Groot's coral recreation value spans seven orders of magnitude, and the means exceed the medians by up to 16× (mangroves). Site context (GDP/capita, population, scarcity) drives value, which is why de Groot's meta-regression for inland wetlands reached only an adjusted R² of 0.442.
- **Non-additivity.** Values are average, not marginal. Scaling them to a whole region, or summing them with the whale or elephant cards, double-counts.

The tool should therefore always print the method, the unit-value source, the band, the note "order-of-magnitude, not a price", and the note "does not include non-use, relational or intrinsic values".

## v1 method (what `natural_value` should implement)

1. **Area by class.** Read the WorldCover v200 tiles intersecting the AOI and tally pixel area per class. Use geodesic area per pixel at the tile latitude.
2. **Map classes to biomes and assign unit values.** The mid value comes from Costanza 2014 (2011 column) and the low/high from de Groot 2012 Table 3 min and max. Classes map as follows:
   - 10 → tropical forest if |lat| < 23.44°, otherwise temperate/boreal
   - 20 → woodlands (de Groot) or grass/rangelands (Costanza)
   - 30 → grass/rangelands
   - 40 → cropland (no de Groot range, so show the mid only)
   - 50 → urban (mid only)
   - 60, 70, 100 → 0 (desert, ice/rock and tundra are not valued)
   - 80 → lakes/rivers
   - 90 → swamps/floodplains (inland wetlands)
   - 95 → tidal marsh/mangroves (coastal wetlands)
3. **Currency.** Treat 2007 Int$ as 2007 USD, per de Groot's footnote, and multiply by the **US CPI-U ratio 258.811 / 207.342 = 1.24823**. These are the BLS CPI-U U.S. city average annual averages for 2020 and 2007, series CUUR0000SA0, fetched from the BLS API. State in the output that this ignores PPP drift.
4. **Outputs.** Report the annual flow as low, median (secondary), mid and high. Report the 100-year undiscounted total (100 × annual) and the 100-year NPV at 2%, which uses an annuity factor of 43.098.
   - The 2% rate is justified by the OMB Circular A-4 revision of 9 Nov 2023, which set 2.0% for effects in 2023–2079 ([A-4 2023](https://bidenwhitehouse.archives.gov/wp-content/uploads/2023/11/CircularA-4.pdf)).
   - Note honestly that OMB rescinded that revision and reinstated the 2003 A-4, with its 3% and 7% rates, under EO 14192 ([OMB M-25-15, 2025](https://www.whitehouse.gov/wp-content/uploads/2025/03/M-25-15-Recission-and-Reinstatement-of-Circular-A-4.pdf)).
   - For comparison, the Stern Review's effective rate is 1.4%: 0.1% pure time preference plus η = 1 × 1.3% growth ([UK Parliament SN/EP/4739](https://researchbriefings.files.parliament.uk/documents/SN04739/SN04739.pdf)). The 100-year annuity factor is 53.643 at 1.4% and 31.599 at 3%.
   - Show 2% and 3% as sensitivity.
5. **Worked example: 100 ha of tropical tree cover (2020 USD).**

   | Case | $/ha/yr | 100 ha annual | 100 yr undiscounted | NPV at 2% |
   |---|---:|---:|---:|---:|
   | Mid (Costanza) | 6,718 | $0.67M | $67.2M | $29.0M |
   | Low (de Groot min) | 1,973 | $0.20M | $19.7M | $8.5M |
   | Median (de Groot) | 2,940 | – | – | $12.7M |
   | High (de Groot max) | 26,027 | $2.6M | $260M | $112M |

6. **Uncertainty.** Always label the result "±1 order of magnitude". The low-to-high ratio is about 13× for tropical forest and about 58× for coral reefs.

**v2 would need four things:**

- ESVD-based local meta-analytic transfer, adjusting for GDP/capita, population and site area, subject to confirming the ESVD licence.
- InVEST models for carbon, sediment delivery and water yield, to turn averages into marginal, site-specific values.
- SEEA-EA **condition** indicators, so degraded forest is not valued like intact forest.
- Downstream population from HydroBASINS plus WorldPop or GHS-POP, used to weight regulating services by the number of beneficiaries.

### What shipped in v1 (differences from the plan above)

- **Land cover source.** The tool reads the **CLMS Global Land Cover 2020, 10 m (LCM-10 v1)** via the CDSE Sentinel Hub Statistics API: BYOC `byoc-828f6b20-8ffd-48f8-a1da-fefd271456db`, band `LCM10`, DOI 10.2909/602507b2-96c7-47bb-b79d-7ba25e97d0a9. It is free and open under Reg. (EU) 1159/2013, provided the source is attributed and modifications are stated ([EEA SDI](https://sdi.eea.europa.eu/catalogue/srv/api/records/602507b2-96c7-47bb-b79d-7ba25e97d0a9?language=eng); [CDSE docs](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/clms/land-cover-and-land-use-mapping/global-dynamic-land-cover/lcm_global_10m_yearly_v1.html)).
  - This route needs one histogram request of at most 256 px and no TIFF parser. It does need CDSE credentials.
  - The ESA WorldCover BYOC id `0b940c63-…` does **not** exist on CDSE: the endpoint returned 400 "Collection … does not exist" on 2026-09-26.
  - The zero-key AWS WorldCover COG path described above is the v2 option.
- **Class codes.** LCM-10 uses WorldCover's 11 LCCS classes but numbers them differently: 10 tree, 20 shrub, 30 grass, 40 crop, 50 herbaceous wetland, 60 mangroves, 70 moss/lichen, 80 bare, 90 built-up, 100 water, 110 snow/ice, 254 unclassifiable.
  - These codes were read from the CDSE colour map ([map10.js](https://github.com/eu-cdse/sentinel-hub-custom-scripts/tree/main/clms/land-cover-and-land-use-mapping/global-dynamic-land-cover/lcm_global_10m_yearly_v1)), which reuses the WorldCover palette colour for colour.
  - The EEA metadata lists the classes but not their numbers, so the code-to-class mapping is **UNCONFIRMED** against a primary legend table. It is consistent with the São Félix histogram below: river pixels read as 100 and the town as 90.
- **Band.** The band is the de Groot min–max, widened to include the Costanza mid where the mid falls outside it (lakes/rivers: Costanza 12,512 vs de Groot max 7,757). Cropland and urban have no range in the source, so low = high = mid.
- **Peatland** is not valued, because neither source reports it as its own biome.
- **Pasture caveat, visible in the first live run.** The land-cover map cannot separate cattle pasture on cleared forest from natural grassland. Both get Costanza's grass/rangeland value of $5,200/ha/yr (2020 USD), close to forest's $6,718. In a deforestation frontier this inflates the "alive" total and hides most of the forest-to-cleared gap. It is stated as a blind spot in the tool output. v2 should value converted pasture separately, which needs a pasture layer or GFW loss-year masking.
- **Live result, São Félix do Xingu bbox [-52.4, -6.9, -51.9, -6.4], 2026-09-26.** The box covers 307,028 ha, read at 254×256 px. The land-cover mix is 48.6% tree cover, 44.8% grassland, 4.6% water, 1.4% shrub, 0.3% crop and 0.3% built-up.
  - Annual living value is about **$2.0bn/yr**, with a band of $356M–$5.2bn.
  - Over 100 years that is **$198bn** undiscounted, or **$85bn** NPV at 2% ($62bn at 3%).
  - A 232 ha forest-loss finding carries about $1.56M/yr (band $0.46M–$6.0M) and $156M over 100 years undiscounted.

## Natural Asset Companies: how they would value, and how people would invest

**Design.** On 29 Sep 2023 the SEC published Release No. **34-98665** (File **SR-NYSE-2023-09**), noticing an NYSE proposal to add **Section 102.09** to the Listed Company Manual. It appeared in the Federal Register on 4 Oct 2023, and an order instituting proceedings followed on 28 Dec 2023 ([SEC](https://www.sec.gov/rules-regulations/self-regulatory-organization-rulemaking/sr-nyse-2023-09); [Fed. Reg. notice](https://www.federalregister.gov/documents/2023/10/04/2023-22041/self-regulatory-organizations-new-york-stock-exchange-llc-notice-of-filing-of-proposed-rule-change); [OIP](https://www.federalregister.gov/documents/2023/12/28/2023-28611/self-regulatory-organizations-new-york-stock-exchange-llc-order-instituting-proceedings-to-determine)).

The concept came from Intrinsic Exchange Group, "founded in 2017", whose CEO is Douglas Eger. The filing defines NACs as "corporations that hold the rights to the ecological performance (i.e., the value of natural assets and production of ecosystem services)" of natural or working areas. Those rights can be "licensed like other 'run with the land' rights (such as mineral rights, water rights, or air rights)" from "sovereign nations, private landowners, or companies", with a minimum licence term of 10 years at listing. NACs may run sustainable businesses such as ecotourism or regenerative farming, but "are prohibited from … unsustainable extractive activities … such as mining" ([NYSE filing text](https://www.nyse.com/publicdocs/nyse/markets/nyse/rule-filings/filings/2023/SR-NYSE-2023-09.pdf)).

**Valuation.** Because "most ecosystem services are not yet monetized", each NAC would publish annual **Statements of Ecological Performance** in addition to GAAP accounts. These comprise a Statement of Natural Production, a Statement of Natural Assets and a Statement of the Quality of Underlying Assets. They would rest on an Ecosystem Service Valuation performed "at least annually" and attested by a PCAOB-registered independent accountant.

IEG's proprietary Ecological Performance Framework is "grounded on" **SEEA EA** categories but extends them to 38 services and to Total Economic Value, including non-use values. IEG licensed the framework to NYSE exclusively in the US and remained proprietary. IEG's exhibit to the filing frames the upside in exactly the Costanza lineage: "Natural assets have been valued at about US$5,000 trillion and nature's annual production … at US$125 trillion per year", and an IPO "will succeed in converting the … unpriced value of nature into financial capital". The investor pitch promised a "store of value" and an "uncorrelated asset". Cash flows existed only where services were already monetised, such as carbon credits or ecotourism, so the equity value would have rested largely on ESV numbers rather than dividends.

**Withdrawal.** NYSE withdrew the filing on about 17 Jan 2024, just before the 18 Jan comment deadline: "After reviewing feedback from regulators, market participants and others, we have withdrawn" ([Cooley PubCo](https://cooleypubco.com/2024/01/22/nyse-listing-standards-nacs/)). Opposition included 25 state attorneys general, members of Congress and agricultural and property-rights groups, who objected to public-land "lock-up" and to NYSE's financial interest in and board seat at IEG ([Cooley](https://cooleypubco.com/2024/01/22/nyse-listing-standards-nacs/); [Barrasso/Lummis](https://www.barrasso.senate.gov/newsroom-news-releases-barrasso-lummis-applaud-nyse-for-withdrawing-proposal-to-list-natural-asset-companies-on-the-exchange/)). IEG continues in private markets. A May 2025 Fordham–IEG partnership to create a natural-capital accounting standards body was reported by Wikipedia and is **UNCONFIRMED** at the primary source ([Wikipedia](https://en.wikipedia.org/wiki/Natural_Asset_Company)).

**What is reusable here, and what is not.** The public-good part is the metric chain: SEEA-EA extent, condition, service flow and value, with attested annual statements. The financial product is the licensed rights, the equity and IEG's proprietary framework. earthdeck should reuse only the first.

**Adjacent mechanisms that trade today:**

- **UK Biodiversity Net Gain.** BNG became mandatory on 12 Feb 2024, requiring 10% gain. Statutory credits (the last resort) are priced from **£42,000** per credit up to £650,000 for rare habitats, and two credits are needed per unit ([gov.uk](https://gov.uk/guidance/statutory-biodiversity-credits); prices from a search snippet).
- **Verra Nature Framework.** Launched 29 Oct 2024 under SD VISta. One Nature Credit equals 1% of net biodiversity outcome, measured in quality-hectares ([Verra](https://verra.org/verra-launches-nature-framework/)).
- **Plan Vivo PV Nature.** Issues Plan Vivo Biodiversity Certificates ([Plan Vivo](https://www.planvivo.org/news-insights/plan-vivo-launch-biodiversity-standard)).
- **Carbon credit integrity.** West et al. 2023 (*Science* 381:873) found that only **6.2%** of about 89M ex-ante REDD+ offsets were likely additional when measured against synthetic controls ([PubMed](https://pubmed.ncbi.nlm.nih.gov/37616370/)). A rebuttal exists ([arXiv 2312.06793](https://arxiv.org/pdf/2312.06793)).
- **Debt-for-nature swaps.**
  - Ecuador/Galápagos (9 May 2023): **$1.6bn** of bonds repurchased at about 40 cents, with **$450M** for conservation ([GGGI](https://gggi.org/ecuador-debt-for-nature-swap-in-the-galapagos-islands-launched/)).
  - Belize (Nov 2021): a **$364M** blue bond, a debt reduction equal to 12% of GDP, and about $180M in conservation over 20 years ([TNC case study](https://www.nature.org/content/dam/tnc/nature/en/documents/TNC-Belize-Debt-Conversion-Case-Study.pdf)).
  - Gabon (15 Aug 2023): **$500M** refinanced, an expected **$163M** for ocean conservation, and a blue bond maturing in 2038 ([TNC](https://www.nature.org/en-us/newsroom/tnc-announces-debt-conversion-for-ocean-conservation-in-gabon/)).
- **Costa Rica PSA (FONAFIFO).** Running since 1997. From 1997 to 2005 it signed 5,443 contracts covering 507,830 ha ([CBD](https://www.cbd.int/financial/pes/CostaRica-pes.doc); from a search snippet). Lifetime totals of about 1.16M ha and US$565M are **UNCONFIRMED**.
- **TNFD.** Final recommendations were published 18 Sep 2023 ([TNFD](https://tnfd.global/wp-content/uploads/2023/09/FINAL-18-09-23-TNFD-final-recommendations-release.pdf)). The adopter count of more than 500 organisations is **UNCONFIRMED** as to date.

**The earthdeck angle.** NACs failed partly because the "ecological performance" figure was a proprietary, attested-but-opaque ESV. Such a figure is exactly what an investor, a regulator or a local community cannot check. earthdeck's hash-chained findings ledger combined with `natural_value` could provide the missing *audited ecological-performance layer*. It would publish, per area:

- versioned extent, change and service estimates;
- the exact unit-value source and CPI factor;
- the band;
- detector false-positive rates measured on control AOIs.

All of this would be reproducible from open data. That makes it evidence a NAC-like or TFFF-like instrument could cite, without earthdeck issuing, custodying or pricing any asset.

## The global bioeconomy thesis and the valuation-provider role

**The thesis.** If the world pays for standing nature, the states with the most of it gain the most. The value exists financially only insofar as someone decides to pay. The evidence is mixed:

- **Changing Wealth of Nations 2021 (World Bank).** Renewable natural capital accounts for **23%** of low-income countries' wealth in 2018, down from 39% in 1995. Yet renewable natural capital per person is **3.6× higher** in high-income countries. Produced and human capital make up more than 90% of global wealth, and low-income countries hold under 1% of global wealth despite 8% of the population ([CWON 2021 FAQ](https://thedocs.worldbank.org/en/doc/68f30649a880f91579b2cee4b3db9a57-0320012021/original/CWON-2021-FAQ-102621.pdf)). Natural abundance has not so far translated into wealth. Where it has, rich countries price their own nature highest.
- **Tropical Forest Forever Facility (TFFF).** Launched at COP30 in Belém on 6 Nov 2025, with the World Bank as trustee.
  - Target size is **$125bn**: $25bn of sponsor capital plus $100bn from institutional investors.
  - It pays **about $4 per hectare per year** of conserved forest. At least **20%** goes to Indigenous peoples and local communities.
  - Eligibility requires deforestation below 0.5%/yr. There are 74 eligible countries with more than 1bn ha of forest.
  - Payments are cut per hectare lost, with a 1:35 factor for fire-degraded area ([WRI](https://www.wri.org/insights/financing-nature-conservation-tropical-forest-forever-facility); [TFFF](https://tfff.earth/)).
  - The multiplier for deforested hectares, widely reported as 100–200× ($400–800/ha), is **UNCONFIRMED**.
  - Pledges: "over USD 5.5 billion" with 53 endorsing countries at launch, including about $3bn from Norway and $1bn from Brazil ([TFFF](https://tfff.earth/); [Carbon Brief](https://www.carbonbrief.org/cop30-could-brazils-tropical-forest-forever-fund-help-tackle-climate-change)). WRI reports **$6.7bn** by the end of COP30 from Brazil, Indonesia, France, Germany and Norway.
  - Note the scale gap: $4/ha/yr is about **0.06%** of the $6.7k/ha/yr transfer value above.
- **Kunming-Montreal GBF (Dec 2022).** 30×30 protection. Target 19 is $200bn/yr from all sources by 2030, including international flows of at least $20bn/yr by 2025 and $30bn/yr by 2030. Target 18 cuts harmful subsidies by $500bn/yr ([CBD T19](https://www.cbd.int/gbf/targets/19); [UNEP](https://www.unep.org/resources/kunming-montreal-global-biodiversity-framework)).
- **Country positions.** Brazil (host and sponsor of TFFF), Indonesia (TFFF pledger), Gabon (the 2023 swap), Colombia and DRC. Specific Colombia and DRC positions were not verified in this pass (**UNCONFIRMED**).

**What a neutral valuation provider would need to be.** It would resemble a ratings agency or auditor for natural capital, not a market or custodian:

- follows the SEEA-EA chain of extent, condition, services and asset value;
- runs open methods with versioned coefficients;
- makes every figure reproducible from public data;
- publishes error rates and bands;
- keeps a tamper-evident history;
- sets out a governance and independence policy covering who pays, conflicts of interest and right of reply.

**What earthdeck already has toward that role:**

- a hash-chained, externally witnessable findings ledger;
- deterministic detectors with independent confirmation;
- control-AOI false-positive rates;
- `natural_value` as a transparent benefit-transfer layer;
- zero-key, CC-BY inputs (WorldCover, HydroBASINS, WorldPop).

**What it lacks:**

- condition metrics at scale;
- local calibration through ESVD meta-regression or InVEST;
- ground truth;
- independent governance;
- any standing with standard-setters.

**Risks:**

- **Greenwashing.** A cheap public number can be cited to justify a weak deal. West et al. show how baselines inflate credits.
- **Sovereignty.** Satellite-based valuation of another state's territory is political.
- **Indigenous rights and FPIC.** TFFF's 20% floor exists because benefits otherwise bypass the people living on the land.
- **Commodification.** The IPBES plural-values critique: a dollar figure can crowd out relational and intrinsic values. The tool's caveat line is what guards against this.
