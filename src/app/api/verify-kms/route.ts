/**
 * TEMPORARY verification endpoint for KMS signer — delete after test night.
 * Proves the full Vercel OIDC → WIF → KMS → sign → recover chain works.
 *
 * Gated by VERIFY_KMS_SECRET query param to prevent public use.
 *
 * Usage: GET /api/verify-kms?secret=<VERIFY_KMS_SECRET env var>
 */

import { NextRequest } from "next/server";
import { hashMessage, recoverAddress } from "viem";
import { createKmsAccount, getEthAddressFromKms, _resetKmsClients } from "@/lib/contracts/kms-signer";
import { getConfig } from "@/lib/config";

export async function GET(request: NextRequest): Promise<Response> {
  const secret = request.nextUrl.searchParams.get("secret");
  const expected = process.env.VERIFY_KMS_SECRET;

  if (!expected || !secret || secret !== expected) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const steps: Record<string, unknown> = {};
  const config = getConfig();

  try {
    // Step 1: Derive address from KMS public key
    _resetKmsClients();
    const derivedAddress = await getEthAddressFromKms();
    steps.derivedAddress = derivedAddress;
    steps.keyPath = config.GCP_KMS_KEY_PATH;

    // Step 2: Create KMS account, verify address + nonceManager
    _resetKmsClients();
    const account = await createKmsAccount();
    steps.accountAddress = account.address;
    steps.addressMatch = account.address === derivedAddress;
    steps.nonceManager = Boolean(account.nonceManager);

    // Step 3: Sign a test message via KMS
    const testMessage = "kms-verify-" + Date.now();
    const signature = await account.signMessage({ message: testMessage });
    steps.message = testMessage;
    steps.signature = signature;

    // Step 4: Recover address from signature
    const msgHash = hashMessage(testMessage);
    const recovered = await recoverAddress({ hash: msgHash, signature });
    steps.recovered = recovered;
    steps.recoveryMatch =
      recovered.toLowerCase() === derivedAddress.toLowerCase();

    const ok = steps.addressMatch && steps.nonceManager && steps.recoveryMatch;

    return Response.json({ ok, steps }, { status: ok ? 200 : 500 });
  } catch (err) {
    return Response.json(
      {
        ok: false,
        steps,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      { status: 500 },
    );
  }
}
