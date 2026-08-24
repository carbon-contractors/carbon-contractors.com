import type { Metadata } from "next";
import { Roboto_Mono } from "next/font/google";
import { WalletProviders } from "@/lib/wallet/providers";
import "./globals.css";

const robotoMono = Roboto_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

// Canonical public hostname — matches the wallet-challenge message and MCP docs.
// No env var exists for it yet (see CC-012); promote to config.ts if one is added.
const SITE_URL = "https://carbon-contractors.com";

const SITE_DESCRIPTION =
  "Human-as-a-Service for the agentic web. AI agents hire humans via MCP, pay in USDC on Base.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Carbon Contractors",
  description: SITE_DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "Carbon Contractors",
    url: "/",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Carbon Contractors — Human-as-a-Service for the agentic web",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <meta
          name="talentapp:project_verification"
          content="de413dae5b37b5b1b56fab86c0c5acc72bd302ef6aae22d2868058dad9215f291f7f28b1faa16390dd0eeedb6c9ca7f879d10a2d94be692c8b9f7f7601c2b821"
        />
      </head>
      <body className={robotoMono.variable}>
        <WalletProviders>{children}</WalletProviders>
      </body>
    </html>
  );
}
