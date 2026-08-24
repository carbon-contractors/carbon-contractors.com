import type { MetadataRoute } from "next";

// Canonical host — same constant as src/app/layout.tsx. Deliberately NOT
// NEXT_PUBLIC_BASE_URL: that env is the x402 fund URL and defaults to localhost (CC-013).
export const SITE_URL = "https://carbon-contractors.com";

// Same predicate as middleware.ts and src/app/page.tsx: the gate fails closed and is
// only off when the value is exactly "false" (CC-014). Inlined at build time like the
// middleware, so flipping it on Vercel needs a fresh deploy to take effect here too.
const COMING_SOON = process.env.NEXT_PUBLIC_COMING_SOON !== "false";

export default function robots(): MetadataRoute.Robots {
  if (COMING_SOON) {
    // Gate on: only the coming-soon homepage is crawlable. Google's most-specific
    // rule uses path length, so `Allow: /` + `Disallow: /*` lets `/*` (length 2)
    // win for every URL including `/`. `Allow: /$` pins the homepage exactly;
    // `Disallow: /` covers everything else.
    return {
      rules: { userAgent: "*", allow: "/$", disallow: "/" },
      sitemap: `${SITE_URL}/sitemap.xml`,
    };
  }

  // Gate off: public site is indexable; private/app surfaces stay out.
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/dashboard", "/connect"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
