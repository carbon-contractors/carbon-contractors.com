# Don't Get Rekt: Hardening Your Attack Surface as a Crypto Contractor

**Module 6 of 6 · 5 min read**

---

## This one's personal.

I built Carbon Contractors. I have a cybersecurity background. And I still got caught slipping.

This isn't a theoretical security guide. This is what happened to me, what I did about it in 120 minutes, and the architecture I now use to keep my identity locked down. If it can happen to me, it can happen to you — so let's make sure you're sorted.

## The Monday Night That Started It All

A viral AI platform called "RentAHuman" hit my feed. It was built on vibe-coding — rapidly generated, barely tested infrastructure. Shiny, buzzy, everyone was talking about it.

I signed up. Used my real phone number and primary email. Hit the OTP verification. The app immediately crashed out.

That crash was my wake-up call. Either the infrastructure was catastrophically broken, or something worse was happening between me hitting "verify" and the app responding. Either way, my primary phone number and email were now sitting in a Firebase database I didn't trust, built by people I didn't know, on code that wasn't audited.

A cybersecurity-trained person just handed their identity to a stranger's buggy database on a Monday night. Because the shiny thing was shiny.

## Why this matters for you

As a crypto contractor, your identity stack is different from a normal person's. You have:

- **A wallet** with real money in it
- **A reputation** built on on-chain attestations
- **Profile data** connected to work platforms
- **Recovery paths** that could be hijacked

One compromised email or phone number can cascade through all of it. The attack surface isn't just your wallet — it's everything connected to your wallet.

## The three-tier identity architecture

After the RentAHuman incident, I rebuilt my entire identity stack in 120 minutes. Here's the architecture:

### Tier 1 — The Burner Layer (Public)

A throwaway email and phone number used exclusively for experimental platforms, new signups, and anything you don't fully trust yet.

- **Purpose:** Absorbs the risk so your real identity doesn't.
- **If compromised:** You lose nothing. Burn it, create a new one.
- **Use for:** New apps, viral platforms, anything with "beta" in the name.

### Tier 2 — The Hardened Layer (Private)

Your real operational identity. Clean email accounts with **no phone number attached.** MFA via app-based authenticator only (Google Authenticator, Authy). Backup codes generated, printed, and stored physically.

- **Purpose:** Your day-to-day working identity for trusted platforms.
- **Key rule:** No SMS recovery. Anywhere. On anything.
- **Use for:** Carbon Contractors, your Stables account, your primary crypto accounts.

### Tier 3 — The Nuclear Layer (Recovery)

A private ProtonMail account that nobody knows about. Zero-access encryption. This is the final recovery authority for your critical accounts.

- **Purpose:** The last line of defence. If everything else is compromised, this gets you back in.
- **Key rule:** Never use this email for signups, newsletters, or anything public-facing. It exists for one purpose only.
- **Use for:** Password reset authority for Tier 2 accounts. Nothing else.

## SMS is not security

This is the most important section in this module.

If your two-factor authentication can be bypassed by someone receiving a text message on your phone number, **you don't have two-factor authentication.** You have a single point of failure with a "Please Swap Me" sign on it.

Here's how a SIM swap works:

1. Attacker calls your carrier (or walks into a store)
2. Social-engineers the staff into porting your number to a new SIM
3. Now they receive your SMS messages — including OTP codes
4. They reset your email password via SMS recovery
5. From your email, they reset everything else — exchange accounts, wallets, platform logins

Prepaid carriers are especially vulnerable. The staff aren't security-trained. The verification is minimal. It takes one convincing phone call.

**What to do right now:**

- Remove your phone number from the "Recovery" and "Security" sections of your Google account
- Switch to app-based MFA (Google Authenticator) for everything
- Generate offline backup codes and store them physically — these are your only way back in without a phone number
- Call your carrier and set a **Port-Out PIN** and **Account Freeze**
- Use a unique, random password for every platform — if one database leaks, nothing else falls

## Coinbase Smart Wallet + Passkey: the answer

Here's why we chose Coinbase Smart Wallet for Carbon Contractors:

- **No seed phrase** — can't be socially engineered out of you
- **Passkey authentication** — tied to your device's biometrics, not an SMS code
- **No SMS in the chain** — the entire SIM swap vector is eliminated
- **Device-bound security** — your FaceID or fingerprint can't be ported to another SIM

This isn't a coincidence. The wallet choice was a security decision, not just a UX decision.

## The Monday Night Rule

**Never use your primary identity for a platform you haven't vetted.**

New app on your feed? Tier 1 burner. Interesting new AI tool? Tier 1 burner. Anything where you're the early adopter and the infrastructure hasn't been battle-tested? Tier 1 burner.

Your Tier 2 identity is for platforms you trust and use daily. It earns that trust over time. Nothing gets Tier 2 access on day one.

This one rule would have prevented my entire RentAHuman incident. I didn't follow it. Now I always do.

## The power user endgame: hardware keys

If you want to eliminate remote phishing entirely, **hardware security keys** like YubiKey are the endgame.

A YubiKey is a physical device that you plug in (USB) or tap (NFC) to authenticate. It uses WebAuthn — the same standard behind passkeys — but the key material never leaves the physical device. It can't be phished remotely because the attacker would need to physically hold the key.

This is overkill for most people starting out. But if you're building a serious contracting income through crypto rails, and your wallet balance starts growing, a $70 YubiKey is cheap insurance.

## Your security checklist

Do these today:

- [ ] **Remove phone number from Google account security settings**
- [ ] **Switch all MFA to app-based (Google Authenticator)**
- [ ] **Generate and physically store backup codes**
- [ ] **Set a Port-Out PIN with your carrier**
- [ ] **Create a Tier 1 burner email for experimental signups**
- [ ] **Use unique passwords everywhere** (use a password manager — Bitwarden is free and open-source)
- [ ] **Never sign up for a new platform with your Tier 2 identity**

## What you need to know right now

Three things:

1. **SMS is your biggest vulnerability.** Remove it from your security chain today.
2. **The three-tier architecture works.** Burner for experiments, hardened for operations, nuclear for recovery.
3. **The Monday Night Rule is non-negotiable.** Every shiny new platform gets the burner until it earns your trust.

---

**That's all six modules.** You now understand the full stack: what USDC is, how your wallet works, how agents pay you, how to spend it in Australia, how to automate your intake, and how to keep it all secure.

Welcome to Carbon Contractors. Time to get to work.

**→ [Back to Dashboard](/dashboard)**
