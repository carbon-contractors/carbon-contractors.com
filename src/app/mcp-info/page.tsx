import Link from "next/link";
import styles from "./mcp-info.module.css";

const TOOLS = [
  {
    name: "search_whitepages",
    description:
      "Query the Base-Human whitepages for verified wallet addresses by skill. Returns JSON array of matching humans sorted by reputation.",
    params: ["skill: string"],
    phase: "Discover",
  },
  {
    name: "get_contractor",
    description:
      "Look up a single contractor's full profile by wallet address or UUID. Returns skills, rate, availability, reputation, and notification channels.",
    params: ["wallet?: 0x...", "id?: uuid"],
    phase: "Discover",
  },
  {
    name: "list_skills",
    description:
      "Returns the canonical skill taxonomy — all unique skills registered by contractors on the platform.",
    params: [],
    phase: "Discover",
  },
  {
    name: "request_human_work",
    description:
      "Initiate a task to hire a verified human. Returns a payment_request_id and fund_url. POST to fund_url using an x402-compatible client to pay and activate the task.",
    params: [
      "from_agent_wallet: 0x...",
      "to_human_wallet: 0x...",
      "task_description: string",
      "amount_usdc: number",
      "deadline_hours: 1-720",
    ],
    phase: "Hire",
  },
  {
    name: "get_task_status",
    description:
      "Check the status of a task by payment_request_id. Returns both database state and on-chain escrow state.",
    params: ["payment_request_id: string"],
    phase: "Hire",
  },
  {
    name: "confirm_task_completion",
    description:
      "Mark a task as completed. Triggers escrow release of USDC to the worker.",
    params: ["payment_request_id: string"],
    phase: "Settle",
  },
  {
    name: "register_notification_channel",
    description:
      "Register or update a notification channel for a contractor. When accepts_auto_booking is true, orchestrator agents can hire directly without human approval.",
    params: [
      "contractor_id: uuid",
      "type: email|webhook|telegram|discord",
      "address: string",
      "accepts_auto_booking: boolean",
    ],
    phase: "Settle",
  },
  {
    name: "get_reputation",
    description:
      "Get a contractor's reputation score and task history summary. Completed/disputed/expired counts, total USDC earned, completion rate.",
    params: ["wallet: 0x..."],
    phase: "Reputation",
  },
];

const RESOURCES = [
  {
    name: "human_whitepages",
    uri: "base-human://whitepages/all",
    description: "Full directory of all verified humans on Base.",
  },
  {
    name: "escrow_config",
    uri: "base-human://escrow/config",
    description:
      "Escrow contract address and chain configuration for on-chain interactions.",
  },
];

export default function McpInfoPage() {
  const escrowContract =
    process.env.NEXT_PUBLIC_ESCROW_CONTRACT ?? "Not deployed";
  const network = process.env.NEXT_PUBLIC_BASE_NETWORK ?? "testnet";

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.title}>
          Carbon Contractors
        </Link>
        <nav className={styles.nav}>
          <Link href="/connect" className={styles.navLink}>
            Register
          </Link>
          <Link href="/dashboard" className={styles.navLink}>
            Dashboard
          </Link>
        </nav>
      </header>

      <main className={styles.main}>
        <h1 className={styles.pageTitle}>MCP Server</h1>
        <p className={styles.subtitle}>
          This server implements the Model Context Protocol (MCP) Streamable HTTP
          transport. AI agents connect to discover and hire human workers on
          Base.
        </p>

        <div className={styles.endpoint}>
          <div>
            <div className={styles.endpointLabel}>Endpoint</div>
            <div className={styles.endpointUrl}>/api/basedhuman.mcp</div>
          </div>
        </div>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Tools</h2>
          {TOOLS.map((tool) => (
            <div key={tool.name} className={styles.toolCard}>
              <div className={styles.toolHeader}>
                <div className={styles.toolName}>{tool.name}</div>
                <span className={styles.phaseBadge} data-phase={tool.phase.toLowerCase()}>
                  {tool.phase}
                </span>
              </div>
              <p className={styles.toolDesc}>{tool.description}</p>
              {tool.params.length > 0 && (
                <div className={styles.params}>
                  {tool.params.map((p) => (
                    <span key={p} className={styles.param}>
                      {p}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Resources</h2>
          {RESOURCES.map((res) => (
            <div key={res.name} className={styles.resourceCard}>
              <div className={styles.resourceUri}>{res.uri}</div>
              <p className={styles.resourceDesc}>{res.description}</p>
            </div>
          ))}
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Chain</h2>
          <div className={styles.chain}>
            <span>
              <span className={styles.chainLabel}>Network: </span>
              <span className={styles.chainValue}>
                {network === "mainnet" ? "Base" : "Base Sepolia"}
              </span>
            </span>
            <span>
              <span className={styles.chainLabel}>Escrow: </span>
              <span className={styles.chainValue}>{escrowContract}</span>
            </span>
            <span>
              <span className={styles.chainLabel}>Payment: </span>
              <span className={styles.chainValue}>USDC (6 decimals)</span>
            </span>
          </div>
        </section>
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>x402 Payment Flow</h2>
          <div className={styles.flowSteps}>
            <div className={styles.flowStep}>
              <span className={styles.stepNum}>1</span>
              <span>Agent calls <code>request_human_work</code> via MCP</span>
            </div>
            <div className={styles.flowStep}>
              <span className={styles.stepNum}>2</span>
              <span>Server returns <code>fund_url</code> + <code>payment_request_id</code></span>
            </div>
            <div className={styles.flowStep}>
              <span className={styles.stepNum}>3</span>
              <span>Agent POSTs to <code>/api/fund-task</code> — gets HTTP 402</span>
            </div>
            <div className={styles.flowStep}>
              <span className={styles.stepNum}>4</span>
              <span>x402 client auto-pays USDC via facilitator</span>
            </div>
            <div className={styles.flowStep}>
              <span className={styles.stepNum}>5</span>
              <span>Task activates, worker is notified</span>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Claude Config</h2>
          <pre className={styles.codeBlock}>{`{
  "mcpServers": {
    "carbon-contractors": {
      "type": "streamable-http",
      "url": "https://carbon-contractors.com/api/basedhuman.mcp"
    }
  }
}`}</pre>
        </section>
      </main>
    </div>
  );
}
