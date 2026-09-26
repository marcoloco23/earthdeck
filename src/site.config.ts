// Branding for the public site — the ONE place the product name, tagline, descriptions and
// public URL live. `earthdeck watch export` renders every page title, meta description,
// canonical URL, Open Graph / Twitter card, JSON-LD block and the sitemap from this object.
// Rename here, re-export, done. ("earthdeck" stays only where it names the CLI/npm package.)
//
// The public site is anonymous: no person's name, email, handle or personal hostname goes in
// here or anywhere else the export renders (test/site-export.test.ts greps the output).

export const SITE = {
  /** Wordmark and short name: header, page-title suffix, og:site_name. */
  name: "TerraKeep",
  /** Longer form where one reads better: landing title, JSON-LD, dataset name, footer. */
  fullName: "TerraKeep",
  /** Small label after the wordmark in the header. */
  byline: "Keeping Earth within its limits",
  /** Landing page title, after the name. */
  tagline: ["Keeping Earth", "within its limits."] as const,
  /** The landing's one sentence (its h1), next to the wordmark — the only prose above the fold. Plain words. */
  oneLine: "Satellites watch the planet. Our AI checks what it sees, gets a second opinion, and publishes what holds up. Anyone can check the evidence.",
  /** Default meta description (landing, JSON-LD). */
  description:
    "An autonomous, evidence-backed watch on Earth’s living systems: forest loss, fires in protected land, methane and gas flaring — every case published with evidence anyone can verify against a signed, append-only ledger.",
  /**
   * Public origin used for canonical URLs, og:url/og:image, JSON-LD and sitemap.xml when
   * `--base-url` isn’t passed.
   */
  baseUrl: "https://vitalearth.io",
  /** The publisher, for JSON-LD `Organization`. */
  organization: { name: "TerraKeep", url: "https://vitalearth.io" },
  /** Footer credit. */
  credit: "Built on open data",
  /** Static social card, relative to the site root (1200×630; carries no product name). */
  ogImage: "og.png",
  /**
   * Licence URL for the published findings data (JSON-LD `Dataset.license`). Unset until a
   * licence is chosen — the upstream sources carry their own terms (see the site footer).
   */
  dataLicense: null as string | null,
  locale: "en",
} as const;

export type SiteConfig = typeof SITE;
