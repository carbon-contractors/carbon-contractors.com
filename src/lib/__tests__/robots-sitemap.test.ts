import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LEARN_MODULES } from "@/lib/learn/modules";

// The gate is read at module scope in src/app/robots.ts, so each scenario needs a
// fresh module graph — same approach as middleware.test.ts.
async function loadRobots() {
  const mod = await import("../../app/robots");
  return mod.default();
}

async function loadSitemap() {
  const mod = await import("../../app/sitemap");
  return mod.default();
}

describe("robots and sitemap routes (CC-013)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("gate ON (NEXT_PUBLIC_COMING_SOON !== \"false\")", () => {
    it.each(["unset", "true", "blank", "FALSE"] as const)(
      "when %s, allows only the homepage",
      async (scenario) => {
        if (scenario !== "unset") {
          // blank exercises the CC-097 lesson: "" is not unset, and neither is "false"
          vi.stubEnv(
            "NEXT_PUBLIC_COMING_SOON",
            scenario === "blank" ? "" : (scenario as string)
          );
        }
        const robots = await loadRobots();

        expect(robots.rules).toEqual({
          userAgent: "*",
          allow: "/",
          disallow: "/*",
        });
        expect(robots.sitemap).toBe("https://carbon-contractors.com/sitemap.xml");
      }
    );
  });

  describe("gate OFF (NEXT_PUBLIC_COMING_SOON === \"false\")", () => {
    it("allows the site but keeps private surfaces out", async () => {
      vi.stubEnv("NEXT_PUBLIC_COMING_SOON", "false");
      const robots = await loadRobots();

      expect(robots.rules).toEqual({
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/dashboard", "/connect"],
      });
      expect(robots.sitemap).toBe("https://carbon-contractors.com/sitemap.xml");
    });
  });

  describe("sitemap", () => {
    it("contains exactly the public URLs, derived from LEARN_MODULES", async () => {
      const sitemap = await loadSitemap();
      const urls = sitemap.map((e) => e.url);

      expect(urls).toHaveLength(3 + LEARN_MODULES.length);
      expect(urls).toContain("https://carbon-contractors.com/");
      expect(urls).toContain("https://carbon-contractors.com/learn");
      expect(urls).toContain("https://carbon-contractors.com/services");
      for (const m of LEARN_MODULES) {
        expect(urls).toContain(`https://carbon-contractors.com/learn/${m.slug}`);
      }
      // Absolute canonical URLs only
      for (const url of urls) {
        expect(url).toMatch(/^https:\/\/carbon-contractors\.com\//);
      }
    });
  });
});
