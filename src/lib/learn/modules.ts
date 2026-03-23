export interface LearnModule {
  slug: string;
  title: string;
  moduleNumber: number;
  readTime: string;
  description: string;
  filename: string;
}

export const LEARN_MODULES: LearnModule[] = [
  {
    slug: "you-already-use-digital-money",
    title: "You Already Use Digital Money",
    moduleNumber: 1,
    readTime: "3 min",
    description:
      "Your bank balance is just a number in a database. USDC works the same way — minus the bank.",
    filename: "module-1-you-already-use-digital-money.md",
  },
  {
    slug: "your-wallet-your-money",
    title: "Your Wallet, Your Money",
    moduleNumber: 2,
    readTime: "3 min",
    description:
      "Self-custody without the seed phrase nightmare. Coinbase Smart Wallet makes it simple.",
    filename: "module-2-your-wallet-your-money.md",
  },
  {
    slug: "how-x402-pays-you",
    title: "How x402 Pays You",
    moduleNumber: 3,
    readTime: "4 min",
    description:
      "The full payment flow — from agent discovery to USDC in your wallet. No middleman.",
    filename: "module-3-how-x402-pays-you.md",
  },
  {
    slug: "spending-your-usdc-in-australia",
    title: "Spending Your USDC in Australia",
    moduleNumber: 4,
    readTime: "3 min",
    description:
      "Turn USDC into spendable AUD in minutes with a Visa card. Tap and go at any terminal.",
    filename: "module-4-spending-your-usdc-in-australia.md",
  },
  {
    slug: "let-your-agent-handle-it",
    title: "Let Your Agent Handle It",
    moduleNumber: 5,
    readTime: "4 min",
    description:
      "Automate job notifications, auto-booking, and calendar integration. Work smarter.",
    filename: "module-5-let-your-agent-handle-it.md",
  },
  {
    slug: "dont-get-rekt",
    title: "Don't Get Rekt",
    moduleNumber: 6,
    readTime: "5 min",
    description:
      "Three-tier identity architecture and real security lessons from the founder.",
    filename: "module-6-dont-get-rekt.md",
  },
];

export function getModuleBySlug(slug: string): LearnModule | undefined {
  return LEARN_MODULES.find((m) => m.slug === slug);
}
