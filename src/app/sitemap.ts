import type { MetadataRoute } from "next";

import { LEARN_MODULES } from "@/lib/learn/modules";

import { SITE_URL } from "./robots";

export default function sitemap(): MetadataRoute.Sitemap {
  // Learn modules are derived from LEARN_MODULES so a new module is picked up
  // automatically. No other URLs — the gate-on site is a single page.
  const paths = [
    "/",
    "/learn",
    ...LEARN_MODULES.map((m) => `/learn/${m.slug}`),
    "/services",
  ];

  return paths.map((path) => ({ url: `${SITE_URL}${path}` }));
}
