# How x402 Pays You

**Module 3 of 6 · 4 min read**

---

## An AI agent just hired you. Now what?

You've got a wallet. You're registered on Carbon Contractors. An AI agent has a task that requires a human. Here's exactly what happens, step by step.

No magic. No hand-waving. Just the flow.

## The payment flow

```
Agent finds your profile
        ↓
Agent sends an HTTP request to Carbon Contractors
        ↓
USDC is locked in escrow (the money is real, it's committed)
        ↓
You get notified — email, webhook, or your preferred channel
        ↓
You do the work
        ↓
You submit your deliverable
        ↓
Attestation is recorded on-chain (proof the work happened)
        ↓
USDC releases from escrow to your wallet
        ↓
Done. Money in your wallet. Seconds, not days.
```

## What is x402?

HTTP — the protocol your browser uses to load every webpage — has had a status code reserved for payments since 1997: **402 Payment Required.** It was never implemented. For nearly 30 years, the web had no native way to pay for things at the protocol level.

**x402** finally builds it. It's a payment protocol that lets AI agents include payment directly in HTTP requests. The agent doesn't fill out a form, enter a card number, or log into a bank. It sends a request, the payment is attached, and the work begins.

Think of it like this:

| Traditional hiring | x402 hiring |
|---|---|
| Post a job listing | Agent sends an HTTP request |
| Wait for applications | Your profile matches automatically |
| Interview, negotiate | Price is set in your profile |
| Do the work | Do the work |
| Send an invoice | Deliverable triggers release |
| Chase payment for 30 days | USDC hits your wallet in seconds |
| Maybe get paid | Always get paid — escrow guarantees it |

The entire negotiation-invoicing-payment cycle collapses into a single transaction.

## Escrow: why you always get paid

When an agent sends a work request, the USDC is locked in a smart contract **before you even start.** This isn't a promise to pay — it's money sitting in a transparent, verifiable escrow that neither party can tamper with.

- The agent can't pull the funds back once you've started.
- You can't claim payment without submitting the deliverable.
- If there's a dispute, the escrow logic handles resolution — no accounts payable department, no emails, no "we'll look into it."

The money is committed upfront. You do the work. The money releases. That's the deal, enforced by code.

## Attestation: your on-chain reputation

Every completed job creates an **attestation** — a permanent, public, on-chain record that this work happened. Think of it as a verified review that can't be deleted, edited, or faked.

Over time, your attestations build into a **reputation score.** This is your track record, visible to every agent on the network.

What this means in practice:

- **More attestations = more work.** Agents prefer contractors with proven track records.
- **Quality matters.** Attestations aren't just "completed" stamps — they carry context about the work.
- **It's portable.** Your reputation lives on-chain, not on a platform. If you leave Carbon Contractors tomorrow, your reputation comes with you.
- **It's trustless.** No one has to take your word for it. The blockchain is the receipt.

This is the opposite of gig platforms where your 4.9-star rating disappears the moment you switch to a competitor. Your on-chain reputation is **yours.**

## Why instant and auditable matters

Two things traditional payment systems can't give you simultaneously:

**Instant** — USDC settles on Base in seconds. Not "pending." Not "processing." Not "1–3 business days." In your wallet, spendable, done.

**Auditable** — Every payment, every escrow lock, every attestation is recorded on a public blockchain. You can verify any transaction yourself. No trust required — just look it up.

For a contractor, this means no more wondering if the client actually sent the payment, no more waiting for bank processing, and a permanent receipt for every dollar earned.

## What you need to know right now

Three things:

1. **The money is locked before you work.** Escrow means you're never chasing payment.
2. **Every job builds your reputation.** Attestations are permanent, portable, and verifiable.
3. **Set up your notification channel.** You need to know when work comes in.

---

**Next → [Spending Your USDC in Australia](/learn/module-4)** — How to go from USDC in your wallet to tapping your card at the shops.
