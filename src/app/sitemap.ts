import type { MetadataRoute } from "next";

import { LEARN_MODULES } from "@/lib/learn/modules";

import { SITE_URL } from "./robots";

export default function sitemap(): MetadataRoute.Sitemap {
  // Public URL set for launch. Gate-on robots keep crawlers on `/` only; the
  // sitemap still lists the intended surface so flipping the gate is a robots
  // change, not a sitemap rewrite. Learn slugs come from LEARN_MODULES.
  const paths = [
    "/",
    "/learn",
    ...LEARN_MODULES.map((m) => `/learn/${m.slug}`),
    "/services",
  ];

  return paths.map((path) => ({ url: `${SITE_URL}${path}` }));
}
