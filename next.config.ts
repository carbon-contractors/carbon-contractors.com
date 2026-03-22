import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  // MCP route needs Node.js runtime for WebStandardStreamableHTTPServerTransport
  // and crypto module. Do not use edge runtime.
  experimental: {},
  async headers() {
    // NOR-177: Next.js requires 'unsafe-inline' for hydration bootstrap
    // scripts and style injection. 'unsafe-eval' is dev-only (React Fast
    // Refresh). TODO: implement nonce-based CSP for stricter production policy.
    const scriptSrc = isDev
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self' 'unsafe-inline'";
    const styleSrc = "style-src 'self' 'unsafe-inline'";

    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              scriptSrc,
              styleSrc,
              "img-src 'self' data: https:",
              "connect-src 'self' https://*.supabase.co https://sepolia.base.org https://mainnet.base.org wss://*.supabase.co",
              "frame-ancestors 'none'",
            ].join("; "),
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
