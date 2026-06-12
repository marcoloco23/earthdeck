// WGS84 ↔ UTM, hand-rolled so eo_similar needs no proj dependency. Transverse Mercator
// via the Krüger series (same formulation as proj/GeoographicLib to ~6 series terms);
// accurate to well under a meter inside a zone — far below the 10 m pixels it serves.

const A = 6378137.0; // WGS84 semi-major axis
const F = 1 / 298.257223563;
const K0 = 0.9996; // UTM scale factor
const E0 = 500_000; // false easting
const N0_SOUTH = 10_000_000; // false northing, southern hemisphere

const n = F / (2 - F);
const n2 = n * n;
const n3 = n2 * n;
const n4 = n3 * n;
const n5 = n4 * n;
const n6 = n5 * n;
// Rectifying radius
const ABAR = (A / (1 + n)) * (1 + n2 / 4 + n4 / 64 + n6 / 256);

// Krüger series coefficients (forward α, inverse β), 6 terms.
const ALPHA = [
  n / 2 - (2 / 3) * n2 + (5 / 16) * n3 + (41 / 180) * n4 - (127 / 288) * n5 + (7891 / 37800) * n6,
  (13 / 48) * n2 - (3 / 5) * n3 + (557 / 1440) * n4 + (281 / 630) * n5 - (1983433 / 1935360) * n6,
  (61 / 240) * n3 - (103 / 140) * n4 + (15061 / 26880) * n5 + (167603 / 181440) * n6,
  (49561 / 161280) * n4 - (179 / 168) * n5 + (6601661 / 7257600) * n6,
  (34729 / 80640) * n5 - (3418889 / 1995840) * n6,
  (212378941 / 319334400) * n6,
];
const BETA = [
  n / 2 - (2 / 3) * n2 + (37 / 96) * n3 - (1 / 360) * n4 - (81 / 512) * n5 + (96199 / 604800) * n6,
  (1 / 48) * n2 + (1 / 15) * n3 - (437 / 1440) * n4 + (46 / 105) * n5 - (1118711 / 3870720) * n6,
  (17 / 480) * n3 - (37 / 840) * n4 - (209 / 4480) * n5 + (5569 / 90720) * n6,
  (4397 / 161280) * n4 - (11 / 504) * n5 - (830251 / 7257600) * n6,
  (4583 / 161280) * n5 - (108847 / 3991680) * n6,
  (20648693 / 638668800) * n6,
];

const D2R = Math.PI / 180;
const E2 = F * (2 - F); // first eccentricity squared
const E1 = Math.sqrt(E2 / (1 - E2)); // e'  (second eccentricity)

/** UTM zone number (1–60) for a longitude. */
export function utmZone(lon: number): number {
  return Math.min(60, Math.floor(((((lon + 180) % 360) + 360) % 360) / 6) + 1);
}

/** Zone label as used by the AEF dataset directories, e.g. "20S", "33N". */
export function utmZoneLabel(lon: number, lat: number): string {
  return `${utmZone(lon)}${lat < 0 ? "S" : "N"}`;
}

/** Central meridian (degrees) of a UTM zone. */
function centralMeridian(zone: number): number {
  return zone * 6 - 183;
}

export interface UtmCoord {
  easting: number;
  northing: number;
  zone: number;
  south: boolean;
}

/** WGS84 lon/lat (degrees) → UTM. Zone defaults to the natural zone of the longitude. */
export function lonLatToUtm(lon: number, lat: number, zone = utmZone(lon)): UtmCoord {
  const phi = lat * D2R;
  const lambda = (lon - centralMeridian(zone)) * D2R;
  const e = Math.sqrt(E2);
  const tau = Math.tan(phi);
  const sigma = Math.sinh(e * Math.atanh((e * tau) / Math.sqrt(1 + tau * tau)));
  const taup = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
  const xip = Math.atan2(taup, Math.cos(lambda));
  const etap = Math.asinh(Math.sin(lambda) / Math.sqrt(taup * taup + Math.cos(lambda) ** 2));
  let xi = xip;
  let eta = etap;
  for (let j = 0; j < 6; j++) {
    xi += ALPHA[j]! * Math.sin(2 * (j + 1) * xip) * Math.cosh(2 * (j + 1) * etap);
    eta += ALPHA[j]! * Math.cos(2 * (j + 1) * xip) * Math.sinh(2 * (j + 1) * etap);
  }
  const south = lat < 0;
  return {
    easting: E0 + K0 * ABAR * eta,
    northing: (south ? N0_SOUTH : 0) + K0 * ABAR * xi,
    zone,
    south,
  };
}

/** UTM → WGS84 lon/lat (degrees). */
export function utmToLonLat(easting: number, northing: number, zone: number, south: boolean): { lon: number; lat: number } {
  const xi0 = (northing - (south ? N0_SOUTH : 0)) / (K0 * ABAR);
  const eta0 = (easting - E0) / (K0 * ABAR);
  let xip = xi0;
  let etap = eta0;
  for (let j = 0; j < 6; j++) {
    xip -= BETA[j]! * Math.sin(2 * (j + 1) * xi0) * Math.cosh(2 * (j + 1) * eta0);
    etap -= BETA[j]! * Math.cos(2 * (j + 1) * xi0) * Math.sinh(2 * (j + 1) * eta0);
  }
  const e = Math.sqrt(E2);
  const taup = Math.sin(xip) / Math.sqrt(Math.sinh(etap) ** 2 + Math.cos(xip) ** 2);
  // Newton-iterate tau from tau'
  let tau = taup;
  for (let i = 0; i < 7; i++) {
    const sigma = Math.sinh(e * Math.atanh((e * tau) / Math.sqrt(1 + tau * tau)));
    const taupi = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
    const dtau =
      ((taup - taupi) / Math.sqrt(1 + taupi * taupi)) *
      ((1 + (1 - E2) * tau * tau) / ((1 - E2) * Math.sqrt(1 + tau * tau)));
    tau += dtau;
    if (Math.abs(dtau) < 1e-14) break;
  }
  const phi = Math.atan(tau);
  const lambda = Math.atan2(Math.sinh(etap), Math.cos(xip));
  return { lon: centralMeridian(zone) + lambda / D2R, lat: phi / D2R };
}
