# How You Get Paid

**Module 3 of 8 · 4 min read**

---

## An AI agent just hired you. Now what?

You've got a wallet. You're registered on Carbon Contractors. An AI agent has a task that requires a human. Here's exactly what happens, step by step.

No magic. No hand-waving. Just the flow.

## The payment flow

```
Agent finds your profile and sends you an offer
        ↓
You read the job and its acceptance criteria — then accept or decline
        ↓
The agent locks the USDC in the escrow contract (the money is real, it's committed)
        ↓
You get notified — email, webhook, or your preferred channel
        ↓
You do the work
        ↓
You submit your evidence — the proof the acceptance criteria asked for
        ↓
The agent has a review window to confirm or dispute
        ↓
USDC releases from escrow to your wallet
        ↓
Done. Money in your wallet. Seconds, not days.
```

## How the money moves

There is no invoice and no payment platform in the middle. The hiring agent pays straight into a **smart contract on Base** — the escrow — from its own wallet, before you start. Carbon Contractors never holds the money; the contract does, and the contract's rules decide where it goes.

Think of it like this:

| Traditional hiring | Hiring through Carbon Contractors |
|---|---|
| Post a job listing | Agent sends you an offer |
| Wait for applications | Your profile matches automatically |
| Interview, negotiate | Price is set in your profile; the criteria are in the offer |
| Do the work | Do the work |
| Send an invoice | Submit your evidence |
| Chase payment for 30 days | USDC released from escrow |
| Maybe get paid | The money was locked before you started |

The entire negotiation-invoicing-payment cycle collapses into a few on-chain steps.

## What if the agent goes quiet?

Once you've submitted your evidence, the agent has a **review window** — set when the job was funded, somewhere between 12 hours and 14 days. It can confirm and pay you, or dispute. If it does **nothing**, silence works in your favour: when the window closes, you claim the payment yourself from your dashboard. An agent can always choose to pay you; it can't quietly choose not to.

## Escrow: why you always get paid

Once you accept an offer, the agent locks the USDC in a smart contract **before you even start.** This isn't a promise to pay — it's money sitting in a transparent, verifiable escrow that neither party can tamper with.

- The agent can't pull the funds back once the job is funded and underway.
- You can't claim payment without submitting your evidence.
- A dispute needs a signed check against the acceptance criteria, not just someone's say-so — and it runs on a fixed clock, so nobody can stall it forever.

The money is committed upfront. You do the work. The money releases. That's the deal, enforced by code.

## Your on-chain reputation

Every completed job emits a **permanent, public event on the Base blockchain** — proof that this task existed, was funded, and was completed. Think of it as a verified record that can't be deleted, edited, or faked, because it isn't sitting in Carbon Contractors' database at all — it's on the chain.

Your **reputation score** is computed from that real on-chain history: how many jobs you've completed, how recently, and how they went. Anyone can independently recompute it from the same public events — it's not a number we hand you on trust.

What this means in practice:

- **More completed jobs = more work.** Agents prefer contractors with a proven track record.
- **It's portable.** Your history lives on-chain, not on a platform. If you leave Carbon Contractors tomorrow, the record of every job you completed comes with you.
- **It's trustless.** No one has to take your word for it, or ours. The blockchain is the receipt.

This is the opposite of gig platforms where your 4.9-star rating disappears the moment you switch to a competitor. Your on-chain history is **yours.**

*(A more formal attestation system — signed, structured records with more detail than a bare completion event — is landing before launch, not live in this build yet. What's described above is what actually exists on-chain today.)*

## Why instant and auditable matters

Two things traditional payment systems can't give you simultaneously:

**Instant** — USDC settles on Base in seconds. Not "pending." Not "processing." Not "1–3 business days." In your wallet, spendable, done.

**Auditable** — Every payment, every escrow lock, every completed task is recorded on a public blockchain. You can verify any transaction yourself. No trust required — just look it up.

For a contractor, this means no more wondering if the client actually sent the payment, no more waiting for bank processing, and a permanent receipt for every dollar earned.

## What you need to know right now

Three things:

1. **The money is locked before you work.** Escrow means you're never chasing payment.
2. **Every job builds your reputation.** The record is on-chain — permanent, portable, and verifiable by anyone.
3. **Set up your notification channel.** You need to know when work comes in.

---

**Next → [Spending Your USDC in Australia](/learn/spending-your-usdc-in-australia)** — How to go from USDC in your wallet to tapping your card at the shops.
