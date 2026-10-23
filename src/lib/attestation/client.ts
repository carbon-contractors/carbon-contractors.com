/**
 * attestation/client.ts — the dashboard side of the completion attestation (CC-036,
 * ADR-0008 A3.4/A3.5). Pure, so it is testable without a browser.
 *
 * The one rule that matters here: **the worker's wallet only ever sends the publish
 * transaction to the EAS predeploy, on the app's chain, with no value.** The API builds the
 * calldata, but the client does not take its word for where to send it — a response that
 * named any other address or chain would otherwise have the worker sign whatever it said.
 */

const EAS_PREDEPLOY = "0x4200000000000000000000000000000000000021";
const HEX = /^0x[0-9a-fA-F]*$/;

/** The parts of `/api/tasks` this needs. */
export interface AttestableTask {
  status: string;
  on_chain?: { state?: string } | null;
}

/**
 * Whether the task has paid its worker, so an attestation exists to fetch. `Completed` is
 * always a worker payout; `Resolved` is only when the ruling went the worker's way, which
 * settlement-sync records as DB status `completed` (CC-080). The server is still the
 * authority and answers 409 otherwise.
 */
export function isAttestable(task: AttestableTask): boolean {
  const state = task.on_chain?.state;
  return state === "Completed" || (state === "Resolved" && task.status === "completed");
}

/** A stable, recognisable filename for the downloaded attestation. */
export function attestationFilename(uid: string, paymentRequestId: string): string {
  const short = HEX.test(uid) && uid.length >= 10 ? uid.slice(2, 10) : paymentRequestId.slice(0, 8);
  return `carbon-contractors-completion-${short}.json`;
}

export interface PublishResponse {
  to: string;
  calldata: string;
  chainId: number;
}

/**
 * Validate the API's publish response into the transaction the wallet will send.
 * @throws Error with worker-readable copy when anything is off — nothing is sent.
 */
export function publishTransaction(
  publish: PublishResponse,
  appChainId: number,
): { to: `0x${string}`; data: `0x${string}`; chainId: number; value: bigint } {
  if (typeof publish?.to !== "string" || publish.to.toLowerCase() !== EAS_PREDEPLOY) {
    throw new Error("The publish request does not target the EAS contract, so it was not sent.");
  }
  if (publish.chainId !== appChainId) {
    throw new Error("The publish request is for a different network, so it was not sent.");
  }
  if (typeof publish.calldata !== "string" || !HEX.test(publish.calldata) || publish.calldata.length < 10) {
    throw new Error("The publish request was malformed, so it was not sent.");
  }
  return {
    to: EAS_PREDEPLOY,
    data: publish.calldata as `0x${string}`,
    chainId: appChainId,
    value: BigInt(0),
  };
}
