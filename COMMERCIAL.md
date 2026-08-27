# Commercial licensing

Carbon Contractors is published under the **GNU Affero General Public License, version 3 or later**
(`LICENSE`). This page explains what that means in practice, and offers an alternative for anyone
who cannot work within it.

**Status: in force for the AGPL grant, 2026-08-26.** `ADR-0006` D1 is accepted and the entity is
settled — **copyright is retained by Aaron James Clifft personally.** The AGPL-3.0-or-later grant in
`LICENSE`, the `contracts/` MIT carve-out in `contracts/LICENSE`, and the inbound contribution grant
below are operative from that date.

**The commercial alternative is an invitation to negotiate, not an offer capable of acceptance.**
There is no price list and no standard form, deliberately — see *Commercial licence* below. Anything
beyond the AGPL grant still wants a lawyer's read, and the contact address must exist before this
page is published.

---

## Why AGPL, and not MIT

`README.md` previously declared MIT and no `LICENSE` file existed. The change is deliberate and it
follows from the project's stated goal — *that this can exist in perpetuity after I am gone, as long
as others see value in it* (`ADR-0006`).

- **MIT lets the project be taken private.** A successor could fork it, operate it as a closed
  service and publish nothing. The fork would survive; the *verifiability* would not, and
  verifiability is the entire product.
- **AGPL section 13 closes the network loophole.** Anyone who runs a modified version as a network
  service must offer its source to the users of that service. For a platform whose trust model is
  "published rules, published inputs, re-runnable result" (`ADR-0001` D9), that is not an ideological
  choice — it is the licence clause that keeps the trust model true after a change of hands.
- **It costs nothing today.** There are no external contributors and no commercial users to disrupt.
  Relicensing later, with contributors, is much harder. This is a one-way door taken while it is
  free.

## What is *not* AGPL

**`contracts/` stays MIT.** `CarbonEscrow.sol` and `ReputationStake.sol` carry
`// SPDX-License-Identifier: MIT` and are deployed and source-verified on a public chain.

- Copyleft over deployed bytecode is close to meaningless — the "source" is already published by
  verification, and there is no distribution event to attach conditions to.
- The protocol *wants* permissive integration. An agent framework, a wallet, or a competing
  front-end that reads the escrow should face no licence friction; that is how the protocol outlives
  any one operator.
- The value being protected by copyleft is the **platform implementation** — the checker, the verdict
  service, the app, the MCP server — not the settlement primitive.

Anything in this repo outside `contracts/` is AGPL-3.0-or-later unless its own header says otherwise.

## What AGPL means for you, in plain terms

| You want to… | Then |
| :-- | :-- |
| Read, audit, or verify the code | Nothing required. That is the point of the repo being public (`CC-056`). |
| Run it privately, unmodified, for yourself | Nothing required. |
| Fork it and run it as a public service | Fine — publish your source, including your modifications, to your users. |
| Build an agent or client that talks to the deployed contract or a running MCP server | Nothing required. Using a service is not covered by the licence; only running the software is. |
| Embed this code in a closed-source product or service | You need a commercial licence. See below. |

If you are unsure which row you are in, ask before you build. Nobody benefits from a licence
argument after the fact.

## Commercial licence

A commercial licence removes the AGPL's source-disclosure obligations for a specific product or
deployment. It is available from the copyright holder.

- **Copyright holder:** **Aaron James Clifft**, personally. **Accepted `ADR-0006` D1, 2026-08-26.**
  Not held by a company, which keeps the licensing right with the author and makes the succession
  question an estate question rather than a corporate one. Two consequences worth stating: the estate
  inherits the copyright directly, and any later assignment to an entity is a deliberate act with its
  own paperwork rather than something that happens by default.
- **Contact:** `licensing@carbon-contractors.com` *(placeholder — must exist before this page is
  published)*
- **Terms:** negotiated per deployment. There is no published price list, because there is no
  commercial user yet and inventing one now would be fiction.
- **What it does not cover:** a commercial licence grants relief from copyleft. It grants no warranty,
  no support commitment, and no indemnity. `LICENSE` sections 15–17 apply regardless.

## Contributions

Dual licensing only works if one party can relicense the whole work. That requires every contributor
to grant that right, and it has to be asked for **before** the contribution is merged, not after.

Until a formal CLA exists, contributions are accepted on this basis, stated in `SECURITY.md` and in
the PR template:

> By submitting a contribution you certify that you wrote it or have the right to submit it, and you
> license it to the project under the AGPL-3.0-or-later **and** grant the copyright holder the right
> to license your contribution under other terms, including commercially.

That is a DCO-style inbound grant with an explicit relicensing right. If Carbon Contractors ever
acquires contributors it cares about keeping, replace it with a proper CLA.

**Contributions to `contracts/` are inbound-MIT**, consistent with the carve-out above and with
`contracts/LICENSE`, which states it as a file rather than leaving it to the SPDX headers.

## Prospective, not retroactive

The repo carried a `README.md` declaration of MIT with no `LICENSE` file until 2026-08-19. Anyone who
took a copy under that declaration keeps whatever rights it granted them. The AGPL applies from the
commit that introduces `LICENSE` forward. Nothing here is an attempt to withdraw a grant already
made — and per `CC-056`, the disclosure posture is to say so plainly rather than quietly restate
history.

Related: `LICENSE`, `ADR-0006` (continuity and the right to fork), `CC-056` (public-by-design),
`SECURITY.md`.
