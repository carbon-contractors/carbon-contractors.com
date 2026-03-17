# Let Your Agent Handle It

**Module 5 of 6 · 4 min read**

---

## You've been doing everything manually. That's fine — until it isn't.

Modules 1–4 got you set up: wallet, payments, spending. You get notified about work, you accept it, you do it, you get paid. That works.

But what happens when you're getting five job requests a day? Ten? What if one comes in at 2am and gets snapped up by another contractor before you wake up?

This module is about removing yourself as the bottleneck.

## How notifications work today

When you registered on Carbon Contractors, you set a **notification channel** — the way the platform tells you work is available. Right now, that's likely one of:

- **Email** — a job request lands in your inbox.
- **SMS** — a text message with the job details.
- **Webhook** — a POST request to a URL you control.

Email and SMS are fine for getting started. You see the notification, you decide, you accept or decline. Human in the loop at every step.

The webhook option is where things get interesting.

## From notification to endpoint

A **webhook** is just a URL that receives data. When a job request comes in, Carbon Contractors sends the details to your URL instead of your inbox.

The difference: an inbox needs a human to read it. An endpoint can have **code** reading it.

That means you can build (or deploy) a simple agent that:

1. **Receives** the job request at your endpoint
2. **Evaluates** it against your criteria (rate, time estimate, skill match)
3. **Accepts or declines** automatically
4. **Notifies you** only when action is needed

You're not replacing yourself. You're giving yourself a filter that works 24/7.

## accepts_auto_booking: the on/off switch

In your Carbon Contractors profile, there's a setting called **accepts_auto_booking.** Here's what it does:

| Setting | What happens |
|---|---|
| **Off** (default) | You get notified about every matching job. You manually accept or decline. |
| **On** | Jobs that match your profile criteria are accepted automatically. Your agent handles the intake. |

That's it. Off means you're the gatekeeper. On means your agent is.

You control the criteria — minimum rate, maximum hours, skill categories, availability windows. The auto-booking only fires when everything matches. It's not accepting random work on your behalf. It's accepting **work you already said yes to** by setting your parameters.

## What "monitoring your email for work requests" actually means

If you're not ready to build a webhook endpoint, there's a middle ground: an email-monitoring agent.

Tools like [n8n](https://n8n.io), [Make](https://make.com), or even a simple script can watch your inbox for Carbon Contractors notification emails and:

- Parse the job details from the email body
- Check against your rules (rate, availability, type of work)
- Auto-reply to accept or flag it for your review
- Log everything to a spreadsheet or dashboard

It's not as clean as a direct webhook, but it works. And you can set it up in an afternoon without touching your Carbon Contractors notification settings.

## Calendar integration: the next step

Once auto-booking is on, the natural question is: "How does it know I'm free on Thursday?"

Calendar integration connects your availability to your profile in real time. When your Google Calendar shows a blocked slot, your profile reflects it. Jobs that conflict with your schedule don't get auto-accepted.

This is the full loop:

```
Job request arrives
        ↓
Your agent checks: rate ✓, skills ✓, hours ✓
        ↓
Calendar check: Thursday 2–5pm — available ✓
        ↓
Auto-accept → work begins
        ↓
Calendar blocks the slot
        ↓
USDC lands when deliverable is submitted
```

No inbox checking. No manual scheduling. No missed jobs at 2am.

## The automation ladder

You don't have to go from zero to full automation overnight. Think of it as a ladder:

| Level | Setup | You do |
|---|---|---|
| **1. Email** | Default | Read every notification, manually accept |
| **2. Email + filter agent** | n8n or script on your inbox | Review pre-filtered jobs, accept the good ones |
| **3. Webhook endpoint** | Custom URL receiving job data | Your code evaluates, you approve edge cases |
| **4. Webhook + auto-booking** | accepts_auto_booking: on | Your agent runs intake, you do the work |
| **5. Full stack** | Auto-booking + calendar sync | Jobs flow in around your life, you just deliver |

Start wherever you're comfortable. Move up when the volume justifies it.

## What you need to know right now

Three things:

1. **Webhook > email** when you're ready. It unlocks automation that email never will.
2. **accepts_auto_booking is safe.** It only accepts jobs matching your exact criteria. You set the rules.
3. **You can automate intake without writing code.** Tools like n8n and Make do the heavy lifting.

---

**Next → [Don't Get Rekt: Security Hardening](/learn/module-6)** — Protect your identity, your wallet, and your attack surface as a crypto contractor.
