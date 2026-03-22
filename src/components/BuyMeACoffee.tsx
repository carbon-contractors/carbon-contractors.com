"use client";

import { useState, useCallback } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import styles from "./BuyMeACoffee.module.css";

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

const USDC_ADDRESS = process.env.NEXT_PUBLIC_USDC_ADDRESS as `0x${string}`;
const TIP_WALLET = process.env.NEXT_PUBLIC_TIP_WALLET_ADDRESS as `0x${string}`;

const AMOUNTS = [
  { label: "$2", value: BigInt(2_000_000) },
  { label: "$5", value: BigInt(5_000_000) },
  { label: "$10", value: BigInt(10_000_000) },
] as const;

export default function BuyMeACoffee() {
  const { isConnected } = useAccount();
  const {
    writeContract,
    data: hash,
    error: writeError,
    isPending: isSigning,
    reset,
  } = useWriteContract();
  const { isSuccess: txConfirmed, isLoading: isConfirming } =
    useWaitForTransactionReceipt({ hash });

  const [activeAmount, setActiveAmount] = useState<string | null>(null);

  // Derive display state from hook values — no effects needed
  const getButtonState = useCallback(
    (label: string) => {
      if (activeAmount !== label) return "idle";
      if (writeError) return "error";
      if (txConfirmed) return "success";
      if (isConfirming) return "confirming";
      if (isSigning) return "pending";
      return "idle";
    },
    [activeAmount, writeError, txConfirmed, isConfirming, isSigning]
  );

  const isBusy = isSigning || isConfirming;

  function handleTip(label: string, amount: bigint) {
    if (!isConnected || !TIP_WALLET || !USDC_ADDRESS) return;
    reset();
    setActiveAmount(label);
    writeContract({
      address: USDC_ADDRESS,
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [TIP_WALLET, amount],
    });
  }

  function handleReset() {
    reset();
    setActiveAmount(null);
  }

  if (!TIP_WALLET || !USDC_ADDRESS) return null;

  // After success or error, show a reset button
  const showReset = txConfirmed || writeError;

  return (
    <div className={styles.container}>
      <span className={styles.heading}>BUY ME A COFFEE</span>
      <div className={styles.buttons}>
        {AMOUNTS.map(({ label, value }) => {
          const btnState = getButtonState(label);
          const disabled = !isConnected || isBusy;

          return (
            <button
              key={label}
              className={`${styles.btn} ${btnState === "success" ? styles.btnSuccess : ""} ${btnState === "error" ? styles.btnError : ""}`}
              disabled={disabled}
              onClick={() => (showReset ? handleReset() : handleTip(label, value))}
              title={isConnected ? `Send ${label} USDC` : "Connect wallet first"}
            >
              {btnState === "pending" && "SIGNING..."}
              {btnState === "confirming" && "CONFIRMING..."}
              {btnState === "success" && "SENT!"}
              {btnState === "error" && "FAILED"}
              {btnState === "idle" && `${label} USDC`}
            </button>
          );
        })}
      </div>
      {!isConnected && (
        <span className={styles.hint}>CONNECT WALLET TO TIP</span>
      )}
    </div>
  );
}
