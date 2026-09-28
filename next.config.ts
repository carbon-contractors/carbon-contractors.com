import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";
const isProduction = process.env.VERCEL_ENV === "production";

// Vercel injects its own review-feedback toolbar script (vercel.live) on preview
// deployments only — it never loads in production. Scope the allowance accordingly
// rather than widening production's CSP for a script it will never serve.
const vercelToolbarSrc = isProduction ? "" : " https://vercel.live";

// WalletConnect / Reown AppKit (the QR modal): relay websocket, RPC, the wallet
// list and its fonts, and the verify iframe. Per Reown's published CSP list.
// Only exercised when NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is set.
const walletConnectConnect = [
  "https://rpc.walletconnect.com",
  "https://rpc.walletconnect.org",
  "https://relay.walletconnect.com",
  "https://relay.walletconnect.org",
  "wss://relay.walletconnect.com",
  "wss://relay.walletconnect.org",
  "https://pulse.walletconnect.com",
  "https://pulse.walletconnect.org",
  "https://api.web3modal.com",
  "https://api.web3modal.org",
  "https://keys.walletconnect.com",
  "https://keys.walletconnect.org",
].join(" ");
const walletConnectFrames =
  "https://verify.walletconnect.com https://verify.walletconnect.org https://secure.walletconnect.com https://secure.walletconnect.org";

const nextConfig: NextConfig = {
  // MCP route needs Node.js runtime for WebStandardStreamableHTTPServerTransport
  // and crypto module. Do not use edge runtime.
  experimental: {},
  async headers() {
    // NOR-177: Next.js requires 'unsafe-inline' for hydration bootstrap
    // scripts and style injection. 'unsafe-eval' is dev-only (React Fast
    // Refresh). TODO: implement nonce-based CSP for stricter production policy.
    const scriptSrc = isDev
      ? `script-src 'self' 'unsafe-inline' 'unsafe-eval'${vercelToolbarSrc}`
      : `script-src 'self' 'unsafe-inline'${vercelToolbarSrc}`;
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
              "font-src 'self' data: https://fonts.reown.com",
              `connect-src 'self' https://*.supabase.co https://sepolia.base.org https://mainnet.base.org wss://*.supabase.co https://cca-lite.coinbase.com ${walletConnectConnect}`,
              `frame-src https://keys.coinbase.com ${walletConnectFrames}${vercelToolbarSrc}`,
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
