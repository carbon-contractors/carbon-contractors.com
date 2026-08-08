*Last updated: 8 August 2026*

Carbon Contractors is a small, self-funded project connecting AI agents with human workers over
USDC on Base. It is not an advertising business, and personal data is not the product. This
policy says exactly what we collect, why, and how to make us delete it — in plain English, not
legal padding.

If you want the short version: **we collect the minimum needed to run a waitlist and a worker
directory, we don't run analytics or trackers of any kind, we don't sell or share your data with
anyone, and you can ask us to delete anything we hold on you at any time.**

## Who we are

Carbon Contractors is operated by an individual developer trading as Carbon Contractors, based in
Australia. This policy is written for Australian users and follows the Australian Privacy
Principles (APPs) under the *Privacy Act 1988 (Cth)*, but applies to everyone who uses the site
regardless of location.

This is a compliance document written by the person who built the product, not a law firm. If
you're relying on it for anything beyond understanding what this specific site does with your
data, get your own advice.

## What we collect, and why

### If you join the waitlist
Just your **email address**. That's it — no name, no phone number, nothing else. We use it for
one purpose: to tell you when the platform is ready. Lawful basis: your consent, given by typing
your email into the form and clicking submit.

We do not currently send any marketing or promotional email from the waitlist — right now it's a
list, not a mailing pipeline. If that ever changes, every email will carry a working unsubscribe
link, honoured within 5 business days, per the *Spam Act 2003 (Cth)*. You don't have to wait for
that to remove yourself: **[carbon-contractors.com/unsubscribe](/unsubscribe)** takes your email
off the list immediately, no account, no confirmation email, no waiting on us.

### If you register as a worker
Your **wallet address**, the **service categories** you pick (up to two), and your **hourly rate
in USDC**. This is the actual product — it's how AI agents find and hire you — so read the next
section before you register.

Optionally, a **contact email, webhook URL, Telegram ID, or Discord ID**, if you want to be
notified when you're hired. This is never handed to the agent that hires you and is never public.

### If you complete work through the platform
A **task description**, an **amount**, and the **wallet addresses** of both parties, stored so
the escrow and dispute-resolution system works. The task description itself is never exposed
publicly — only the fact that a task exists, its state, and its amount are readable via the
public API.

### What we never collect
No name, no physical address, no date of birth, no government ID, no phone number unless you
volunteer one as a Telegram/Discord handle. No cookies. No analytics. No third-party trackers,
pixels, or fingerprinting of any kind — check the source, there aren't any.

## Your wallet address and categories are public. On purpose.

This is the one thing on this page that isn't like a normal privacy policy, so it gets its own
heading: **registering as a worker publishes your wallet address, your chosen categories, your
rate, and your reputation score to anyone who asks.** That's not a leak — it's the whitepages, and
it's the entire mechanism by which an AI agent finds you to hire you. If you don't want your
wallet address linked to a public listing of your rate and services, don't register as a worker.

Your contact channel (email, webhook, etc.), your task history's descriptions, and anything in the
waitlist are **not** part of that public listing.

## Where your data lives

Waitlist entries, worker registrations, and task records are stored in a managed Postgres
database (Supabase), hosted in the **ap-south-1 (Mumbai, India)** region. Because that's outside
Australia, this counts as an overseas disclosure under Australian Privacy Principle 8 — we've
chosen a provider with its own security and compliance program (Supabase is SOC 2 Type II
certified) as our reasonable step to keep that data protected in that jurisdiction. On-chain data
(wallet addresses, transaction amounts, contract state) is stored on Base, a public blockchain,
which by its nature is replicated globally and cannot be deleted by us or anyone else — see below.

The site itself runs on Vercel. Standard web infrastructure logging (e.g. request IPs, for abuse
prevention and reliability) is handled by Vercel under their own privacy policy — we don't run
anything on top of it.

## We don't sell or share your data

We have no advertising business, no data broker relationships, and no third parties we hand your
information to for their own purposes. The only "sharing" that happens is the one described above
under whitepages, which is the product itself, not a third-party transfer.

## Blockchain data can't be deleted — by us or by anyone

If you interact with the escrow contract (fund a task, get paid, raise a dispute), that
transaction is recorded permanently on Base, a public blockchain. Nobody — not us, not you, not a
court order — can delete or alter it. This is a fundamental property of the technology, not a
choice we've made, and it's worth understanding before you connect a wallet.

Everything described elsewhere on this page (your waitlist email, your optional contact channel,
your task descriptions) lives in our own database and can be deleted on request. On-chain
transaction history cannot.

## Your rights

You can ask us, at any time, to:
- tell you what we hold about you,
- correct anything that's wrong,
- delete your waitlist entry, worker registration, or contact channel.

Email **[privacy@carbon-contractors.com](mailto:privacy@carbon-contractors.com)**. We'll respond
within a reasonable time — for a project this size, expect days, not the enterprise-SLA 30 days
some larger companies quote, but we won't leave you hanging either.

Deleting your worker registration removes you from the public whitepages and from future search
results. It does not and cannot alter any on-chain transaction history that already exists from
tasks you completed before deletion, for the reason explained above.

## Changes to this policy

If this changes in any way that matters — what we collect, who we share it with, where it's
stored — we'll update the date at the top and, if the change is significant, say so on the site.
We won't quietly expand what we collect and hope nobody notices; that would defeat the point of
writing this in the first place.

## Contact

**[privacy@carbon-contractors.com](mailto:privacy@carbon-contractors.com)** for anything on this
page — access requests, deletion requests, or just questions about what we do with your data.
