import PageShell from "@/components/PageShell";
import styles from "./mcp-info.module.css";

const TOOLS = [
  {
    name: "search_whitepages",
    description:
      "Query the Base-Human whitepages for verified wallet addresses by service category. Returns JSON array of matching humans sorted by reputation.",
    params: ["category: string"],
    phase: "Discover",
  },
  {
    name: "get_contractor",
    description:
      "Look up a single contractor's full profile by wallet address or UUID. Returns categories, rate, availability, reputation, and notification channels.",
    params: ["wallet?: 0x...", "id?: uuid"],
    phase: "Discover",
  },
  {
    name: "list_categories",
    description:
      "Returns the canonical service category taxonomy — all unique categories registered by contractors on the platform.",
    params: [],
    phase: "Discover",
  },
  {
    name: "request_human_work",
    description:
      "Initiate a task to hire a verified human. Requires an authenticated session — the hiring agent is your verified wallet. Returns every parameter needed to fund the escrow yourself: call USDC.approve then escrow.createTask from your own wallet, then POST { payment_request_id } to fund_url to confirm. The confirmation endpoint reads the chain and activates the task once it is Funded.",
    params: [
      "to_human_wallet: 0x... (must be registered)",
      "task_description: string",
      "amount_usdc: number",
      "deadline_hours: 1-720",
      "acceptance_spec?: JSON string",
    ],
    phase: "Hire",
  },
  {
    name: "get_task_status",
    description:
      "Check the status of a task by payment_request_id. Returns both database state and onchain escrow state.",
    params: ["payment_request_id: string"],
    phase: "Hire",
  },
  {
    name: "confirm_task_completion",
    description:
      "Record the agent's confirmation that work is complete, returning the taskId and escrow address. Settlement is the agent's own on-chain action, not the platform's.",
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
      "Escrow contract address and chain configuration for onchain interactions.",
  },
];

export default function McpInfoPage() {
  // `||`, not `??` (CC-097). NEXT_PUBLIC_* is inlined at build time, so a blank
  // Vercel field becomes the literal "" in the bundle: `??` would render an empty
  // contract address instead of "Not deployed". Read directly rather than through
  // getConfig() because Next only inlines literal `process.env.NEXT_PUBLIC_*`
  // references — a value routed through a runtime helper is not substituted at all.
  const escrowContract =
    process.env.NEXT_PUBLIC_ESCROW_CONTRACT || "Not deployed";
  const network = process.env.NEXT_PUBLIC_BASE_NETWORK || "testnet";

  return (
    <PageShell>
      <div className={styles.content}>
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
          <h2 className={styles.sectionTitle}>Authentication</h2>
          <p className={styles.subtitle}>
            Discovery tools are open. Hiring and settlement —{" "}
            <code>request_human_work</code>, <code>confirm_task_completion</code>,{" "}
            <code>dispute_task</code> — need a
            verified wallet, and the task is attributed to it rather than to an
            address you supply. Nonces expire after 60 seconds.
          </p>
          <pre className={styles.codeBlock}>{`POST /api/basedhuman.mcp/challenge
  { "walletAddress": "0x..." }        → { nonce, message, expiresAt }

Sign \`message\` with that wallet, then initialize the MCP session with:
  x-caller-wallet:    0x...
  x-caller-signature: 0x...
  x-caller-nonce:     <nonce>`}</pre>
        </section>

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
          <h2 className={styles.sectionTitle}>Funding Flow</h2>
          <div className={styles.flowSteps}>
            <div className={styles.flowStep}>
              <span className={styles.stepNum}>1</span>
              <span>Agent calls <code>request_human_work</code> via MCP</span>
            </div>
            <div className={styles.flowStep}>
              <span className={styles.stepNum}>2</span>
              <span>Server returns <code>payment_request_id</code> + all <code>createTask</code> parameters</span>
            </div>
            <div className={styles.flowStep}>
              <span className={styles.stepNum}>3</span>
              <span>Agent calls <code>USDC.approve</code> + <code>escrow.createTask</code> from its own wallet</span>
            </div>
            <div className={styles.flowStep}>
              <span className={styles.stepNum}>4</span>
              <span>Agent POSTs <code>{`{ payment_request_id }`}</code> to <code>/api/fund-task</code> to confirm</span>
            </div>
            <div className={styles.flowStep}>
              <span className={styles.stepNum}>5</span>
              <span>Server verifies the on-chain task is <code>Funded</code>, then the task activates</span>
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
      </div>
    </PageShell>
  );
}
