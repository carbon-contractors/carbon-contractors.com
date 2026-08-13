# Let Your Agent Handle It

**Module 5 of 7 · 5 min read**

---

## You've been doing everything manually. That's fine — until it isn't.

Modules 1–4 got you set up: wallet, payments, spending. You get notified about work, you accept it, you do it, you get paid. That works.

But what happens when you're getting five job requests a day? Ten? What if one comes in at 2am and gets snapped up by another contractor before you wake up?

This module is about removing yourself as the bottleneck — honestly, including what's a dashboard setting today and what actually requires you (or an agent you run) to talk to our systems directly.

## What's actually on your dashboard right now

One notification option, today: **email**. When you registered, the optional "Contact Email" field is the only channel the website itself lets you set. There's no toggle in your dashboard for auto-accepting jobs yet — that's not a UI setting you're missing, it genuinely isn't exposed there.

That's not a limitation we're hiding — it's the honest starting point for everything below.

## The lever we do give you: MCP

Carbon Contractors' backend speaks the **Model Context Protocol (MCP)** — the same protocol AI agents use to discover and hire you in the first place. That means every capability the platform has, including the ones not on your dashboard, is reachable by a tool that speaks MCP. Two of those tools matter for automation:

- **`register_notification_channel`** — register an email, webhook, Telegram, or Discord address as where job notifications go, and set **`accepts_auto_booking`**: true or false.
- **`get_contractor`** — look up your own profile (by wallet address) to get the `contractor_id` the above tool needs.

When `accepts_auto_booking` is `true`, an agent hiring you can book you directly against your own stated criteria — categories, rate — with no human approval step in the middle. When it's `false` (the default, and where every website registration currently sits), you're notified and decide yourself.

**This is not a dashboard toggle today.** It's an MCP tool call. Making it means either calling it yourself once (a short script, or a request through any MCP-capable client), or running an agent that calls it on your behalf. That's the rest of this module.

## Two ways to get an agent that can do this

### The no-code way: n8n or Make

[n8n](https://n8n.io) and [Make](https://make.com) are visual, drag-and-drop automation builders. No programming. You can build a workflow that:

- Watches your inbox for Carbon Contractors notification emails
- Parses the job details out of the email body
- Checks the details against rules you set (rate, availability, category)
- Auto-replies to accept, or flags it for your review
- Logs everything to a spreadsheet or dashboard

It's not talking to our MCP tools directly — it's reading the same email a human would and reacting faster. That's a real limitation (it can't flip `accepts_auto_booking` for you), but it's genuinely no-code, and you can have it running in an afternoon.

### The MCP-native way: a personal agent

If you want the real thing — an agent that registers itself as your notification channel and can actually be trusted with `accepts_auto_booking: true` — you need something that can speak MCP, not just read your email. Two options, both self-hosted, both requiring some comfort with config files and a command line (neither is a no-code tool):

- **[Hermes Agent](https://hermes-agent.nousresearch.com/docs)** (Nous Research) — a self-hosted autonomous agent with built-in cron scheduling and **native MCP server support**. Point it at Carbon Contractors' MCP endpoint and it can call `register_notification_channel` and act on job requests as a first-class capability, not a workaround.
- **[OpenClaw](https://docs.openclaw.ai/)** — a self-hosted gateway that puts an AI agent behind chat apps you already use (Telegram, WhatsApp, Discord, Signal, and others). Useful if you want job decisions to happen somewhere you're already looking, with a web dashboard for configuring the rules.

Either gives you an always-on process that can genuinely accept work on your behalf, not just filter your inbox faster.

## What we deliberately didn't build: calendar sync

You might expect the next step to be "connect your Google Calendar and we'll only auto-book you when you're free." We're not building that, on purpose. Reading your calendar means holding real, ongoing personal data about your life — appointments, patterns, who you're free to see and when — and that's a level of access a task marketplace shouldn't be asking for. It's your data, not ours.

If you want that check, your own agent can do it — Hermes and OpenClaw can both be given access to your calendar directly, entirely on your side, with none of that data ever touching Carbon Contractors. We give you the accept/decline lever (`accepts_auto_booking`); what conditions you attach to pulling it is between you and whatever agent you're running.

## The automation ladder

| Level | Setup | You do | Auto-booking? |
|---|---|---|---|
| **1. Email** | Default, on the website | Read every notification, manually accept | No — you're always the gatekeeper |
| **2. Email + filter agent** | n8n or Make watching your inbox | Review pre-filtered jobs, accept the good ones | No — still reading email, just faster |
| **3. MCP-native agent** | Hermes or OpenClaw, registered via `register_notification_channel` | Set your criteria once; your agent runs intake | Yes, if you set `accepts_auto_booking: true` |
| **4. Agent + your own calendar check** | Same agent, calendar access on your side only | Jobs flow in around your life, you just deliver | Yes, gated by whatever rules you built |

Start wherever you're comfortable. Level 1 is genuinely fine for low volume. Level 3 is where this stops being "faster email" and starts being real automation.

## What you need to know right now

Three things:

1. **The dashboard gives you email notifications today. That's it.** Auto-booking is real, but it's an MCP tool call, not a website setting.
2. **n8n/Make can filter your inbox; they can't flip `accepts_auto_booking`.** For that you need something that speaks MCP directly, like Hermes or OpenClaw.
3. **We're not touching your calendar, deliberately.** That check belongs on your agent, on your data, not on our platform.

---

**Next → [Don't Get Rekt: Security Hardening](/learn/module-6)** — Protect your identity, your wallet, and your attack surface as a crypto contractor.
