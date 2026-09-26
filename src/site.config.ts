// Branding for the public site — the ONE place the product name, tagline, descriptions and
// public URL live. `earthdeck watch export` renders every page title, meta description,
// canonical URL, Open Graph / Twitter card, JSON-LD block and the sitemap from this object.
// Rename here, re-export, done. ("earthdeck" stays only where it names the CLI/npm package.)

export const SITE = {
  /** Wordmark and short name: header, page-title suffix, og:site_name. */
  name: "Earth Watch",
  /** Longer form where one reads better: landing title, JSON-LD, dataset name, footer. */
  fullName: "Earth Watch",
  /** Small label after the wordmark in the header. */
  byline: "Earth’s vital signs",
  /** Hero headline, one entry per line. */
  tagline: ["The planet’s vital signs —", "and the value of being alive."] as const,
  /** One-line positioning under the headline, and the default meta description. */
  description:
    "An autonomous, evidence-backed watch on Earth’s living systems: forest loss, fires in protected land, methane and gas flaring — every case published with evidence anyone can verify against a signed, append-only ledger.",
  /**
   * Public origin used for canonical URLs, og:url/og:image, JSON-LD and sitemap.xml when
   * `--base-url` isn’t passed. (Domain still being decided — change it here or pass --base-url.)
   */
  baseUrl: "https://vital.marcsperzel.com",
  /** The publisher, for JSON-LD `Organization`. */
  organization: { name: "Vital Earth", url: "https://vital.marcsperzel.com" },
  /** Where issues (right of reply, false positives) are filed, and the footer credit link. */
  repo: "https://github.com/marcoloco23/earthdeck",
  /** Footer credit for the engine underneath. */
  credit: "built on earthdeck",
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
