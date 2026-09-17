# Pricing

Read `docs/POSITIONING.md` first. Its conclusion is the premise of this document:

> The free tool is the product. Revenue is a test of distribution, not a business.

That is not modesty, it is a design constraint. It rules out most of what a pricing page
would normally do, and everything below follows from taking it seriously.

---

## What the price has to survive

**Eight free browser converters already rank** — Zamzar, FreeConvert, Online2PDF,
OnlineConvertFree, online-convert, i-converter, Aspose, plus LibreOffice for anyone willing
to install it. Every one of them converts a single `.pub` file for nothing. Any price on
single-file conversion is a price on something eight competitors give away, and the
competitor who is free *and* better-known wins that comparison without trying.

**Univik sells a desktop converter at $39, Windows-only.** It is the only proven data point
that anyone pays for this at all, and it is the only real comparable — everything else in
the market is either free-with-upload or a service of unverified delivery.

**The deadline is real and it ends.** Publisher leaves Microsoft 365 on 1 October 2026.
Demand rises into that date and falls away after it, and the fall is steeper than it looks:
perpetual-licence holders can still open their files afterwards, so the forcing function
only ever applied to Microsoft 365 subscribers. Treat any revenue from this as **a pulse
across roughly June 2026 to March 2027, peaking in September**, not as recurring income. A
pricing model that assumes renewal is modelling a world that does not arrive.

So the price has three jobs, in this order:

1. **Do not damage the free path.** It is the distribution mechanism and the entire
   competitive position. A paywall that costs us one free user costs more than it earns.
2. **Produce an unambiguous signal.** The unknown is whether a stranger will pay. A
   muddy result — bundles, tiers, discounts — answers nothing.
3. **Cost nothing if nobody buys.** The architecture is zero-marginal-cost; the commercial
   layer must not be the thing that introduces a running bill or a support queue.

---

## The four candidates, and why three of them lose

### Bulk or batch beyond N files, in the browser — rejected

The clean-looking answer, and the worst one.

The conversion happens on the visitor's own machine and costs us exactly nothing whether
they convert one file or four hundred. A limit is therefore not a price on a resource, it is
a tollbooth on a bridge that is free to cross, and users can feel the difference. Worse, it
does not work: the counter lives in the browser, so reloading the page resets it. Making it
stick requires accounts and server-side enforcement — which means a login, a database, a
running bill, and an identity attached to document conversion. That is a direct attack on
differentiator #1, and it converts the cheapest architecture in the market into an ordinary
SaaS with an ordinary SaaS's costs.

It fails all three jobs at once. Reject it hardest of the four.

### Priority support during the deadline window — rejected

Sells the founder's hours at the exact moment hours are the binding constraint (~25/week),
with unbounded scope: "support" for a file conversion means "fix my file", and the buyer
decides when it is fixed. It cannot be built in advance and sold later, it does not scale,
and it produces the weakest possible signal — someone buying reassurance has told you
nothing about whether the product is worth money.

### Hand-fixing the files that did not convert — rejected as the primary, kept as the fallback

This is the tempting one, and it deserves more than a dismissal, because the qualification
mechanism is close to perfect. `docs/FIDELITY.md` measures five of thirty-one corpus files
that parse without error and produce nothing, and WMF clipart that is dropped with a warning.
`assess()` already tells the user exactly which of their files failed. The product hands the
buyer a list of precisely the files they would pay to have fixed, at the moment they are most
motivated. No other offer here is that well-targeted.

It still loses, for one reason: **delivery is founder-hours**, the single input that cannot
scale and is already scarce. The deadline spike would arrive as a manual queue at the worst
possible moment, and the work — hand-repairing Publisher files the parser cannot read — is
slow, unpredictable, and occasionally impossible. It also cannot be tested cheaply: every
data point costs a day.

Keep it in reserve. It is the designated pivot if the recommendation below is falsified (see
*Falsification*, test 1), and at that point it should be priced per-file and capacity-capped,
not offered openly.

### A desktop batch runner — **recommended**

Point it at a folder; it walks the folder, converts every `.pub` inside, and writes a
spreadsheet of what came out and what needs a human look.

---

## The recommendation

**A cross-platform command-line batch runner. US$29, one-time, includes updates to
31 December 2026.**

Single-file conversion on the website stays free, unlimited, with no account, forever.

### Why this one

**It is a different need, not a crippled version of the free thing.** The upsell is "you
have a folder, not a file". Someone converting one newsletter should use the free tool and
is told so. Someone facing a shared drive with four hundred files has a genuinely different
problem, and dragging files into a browser tab four hundred times is the wrong instrument.
Nothing is withheld from the free user to manufacture that difference.

**The free competitors cannot follow.** Their architecture is upload, which makes bulk
actively worse, not better: uploading four hundred parish files containing member
directories and donor lists is the exact thing our users cannot do. The privacy argument that
wins one file wins four hundred by the same reasoning, only louder.

**Univik cannot follow onto the platforms that matter most.** It is Windows-only. Publisher
never ran on a Mac, so a Mac or Chromebook user has no desktop option at all today — they
are not choosing between $39 and $29, they are choosing between $29 and nothing.

**The demo is free, already built, and runs on the buyer's own file.** They convert one file
on the front page, see exactly what the engine does to *their* layout, including what it
warns about, and only then buy the thing that does it four hundred times. That is the
strongest pre-purchase evidence available and it costs nothing to provide. It also means a
buyer who should not buy finds out for free — which is why the refund promise is cheap to make.

**It keeps job 3.** A signed download has no marginal cost and no support surface beyond
email. If nobody buys, the loss is the build, not a running bill.

### Why $29

The only real anchor is Univik's $39. Sitting under it is deliberate: we are the unproven
newcomer with a CLI where they have an established GUI, so the platform advantage has to be
worth something visible. Below roughly $19 the number starts arguing against itself for a
tool being bought under deadline pressure by an institution — a church or school
administrator does not want the cheapest possible way to rescue the parish archive, and $29
is comfortably inside what can be expensed without asking anyone.

**One-time, not a subscription.** A subscription on a deadline-driven tool is a machine for
generating cancellations and refund requests precisely when the value ends. The "updates to
31 December 2026" boundary is stated openly for the same reason: it is honest about a tool
whose usefulness has an expiry date, and a promise that ends on a date nobody disputes is
cheaper to keep than one that ends when someone complains.

**Refund on request, no argument.** At this price the cost of a refund is lower than the cost
of a paragraph of correspondence, and the guarantee removes the only real objection — "will
it work on *my* files?" — from a buyer who has already been shown the answer for free.

### The uncomfortable part

**The thing being sold does not exist yet.** The extractor (`bin/pubshift-extract`) and the
pipeline (`packages/core`) both exist and are tested; the runner that walks a folder, drives
them, and writes the report has not been built. Nothing in this document is sellable until
it is, and the honest sequence is: build the runner, then switch on payments — not the
reverse. The payment plumbing is implemented and switched off precisely so that this
ordering is possible without a rush later.

---

## Falsification

Stated in advance, with thresholds, because a pricing thesis that cannot be wrong is not a
thesis. The measurement window is the 60 days around 1 October 2026.

1. **Volume is not the payable pain.** ≥20,000 single-file conversions with <0.2%
   click-through to `/batch`. → The pain is *failure*, not volume. Pivot to the hand-fix
   service, priced per file and capacity-capped.
2. **The form factor or the price is wrong.** `/batch` gets meaningful traffic but under 1%
   of its visitors buy. → Do not abandon the thesis; test a GUI wrapper, or $19, before
   concluding people will not pay.
3. **The engine is the blocker, not the packaging.** More than 30% of buyers refund citing
   files that produced nothing. → The five-in-thirty-one empty-file gap is the real problem
   and no amount of batching touches it. Stop selling; fix WMF and the empty parses.
4. **Distribution failed, which was the actual question.** Total revenue across the whole
   window under roughly $500. → This is the *answer*, not a setback. It says the bottleneck
   is reach, not code, exactly as `POSITIONING.md` predicted. The correct response is to stop
   iterating on price and keep the free tool online, because it costs nothing to leave up and
   it is a real asset.

Note what is *not* on this list: revenue targets that would make this a business. None of
these thresholds, met or missed, turn a one-off file conversion into recurring income. The
experiment is worth running because it is cheap and fast, not because it scales.

---

## Setup checklist for the owner

**None of this has been done, and none of it can be done by an agent.** No account exists, no
key has been entered, no API call has been made. The code is complete and inert: with the
variables below unset, `paymentsConfig()` returns null, the `.pay` routes are not compiled,
and the site builds as a pure static export. Payments require a human at every step.

Work through it in order. Steps 1–3 are free and reversible.

1. **Build the thing you are selling.** See *The uncomfortable part*. Do not take money for
   software that does not exist.

2. **Create the Stripe account** at <https://dashboard.stripe.com/register> and complete
   business verification. Expect bank details, an ID document, and a few days.
   - Sole traders and non-US/EU residents: check that your country is on Stripe's supported
     list *before* building anything else around it.

3. **Create the product and price** — Dashboard → Product catalogue.
   - Product: "Pubshift batch runner". Price: **one-time**, USD 29.00.
   - Copy the **price ID** (`price_…`, not `prod_…`) → `STRIPE_PRICE_ID`.
   - If the displayed price changes, update `PRICE_DISPLAY` in
     `apps/web/app/batch/page.pay.tsx` in the same commit. They are two strings that can
     disagree, and if they do, Stripe wins and the customer is right to be annoyed.

4. **Enable Stripe Tax** — Dashboard → Tax. A digital good sold internationally attracts VAT
   in the buyer's country. `createCheckoutSession()` already sends
   `automatic_tax[enabled]=true` and requires a billing address; without Tax enabled on the
   account, that flag does nothing and the liability is yours.

5. **Copy the API key** — Dashboard → Developers → API keys → secret key →
   `STRIPE_SECRET_KEY`. Use `sk_test_…` until step 8 passes. Never commit it; set it in the
   host's secrets UI.

6. **Create the webhook endpoint** — Dashboard → Developers → Webhooks → Add endpoint.
   - URL: `https://<your-domain>/api/stripe/webhook`
   - Events: `checkout.session.completed`, `charge.refunded`, `charge.dispute.created`
   - Copy the **signing secret** (`whsec_…`, *not* an API key) → `STRIPE_WEBHOOK_SECRET`.

7. **Wire fulfilment.** `fulfil()` in `apps/web/lib/payments.ts` currently only logs, on
   purpose: issuing a download link without a durable record would be a payment taken and
   nothing sent. It must (a) be idempotent on `event.id`, backed by real storage rather than
   the in-memory set that only suppresses retry bursts on one warm instance, and (b) return
   quickly, because Stripe treats a slow webhook as a failure and retries it.
   - The cheapest workable version: a signed, expiring download URL emailed by whatever the
     host provides. Resist building a licensing server for a product with a 2026 expiry date.

8. **Test end to end in test mode**, before any real key is used:
   ```bash
   stripe login
   stripe listen --forward-to localhost:3000/api/stripe/webhook   # prints a whsec_ for local use
   PUBSHIFT_PAYMENTS=1 npm run dev -w @pubshift/web
   stripe trigger checkout.session.completed
   ```
   Confirm: the event verifies, fulfilment runs exactly once, and a replay of the same event
   is acknowledged without re-running it. Then deliberately corrupt the signature header and
   confirm a `400`.
   - The verifier itself is already tested: `npm test -w @pubshift/web` covers forgery, replay
     outside the 5-minute window, a body altered after signing, re-serialised JSON, truncated
     signatures, and secret rotation with two `v1` values. 14 tests, all passing. What step 8
     adds is proof that *your* Stripe account is wired to it correctly.

9. **Switch to live keys**, set `PUBSHIFT_PAYMENTS=1` and `NEXT_PUBLIC_PAYMENTS_ENABLED=1`,
   and redeploy. Note that this build is **no longer a static export** — see
   `docs/DEPLOY.md` §5 for what that costs and where it can run.

10. **Publish a refund policy and contact address** before the first sale. "Refund on request,
    no argument" is the policy; it needs to be written on the page, not only in this file.

### Turning it off again

Unset `PUBSHIFT_PAYMENTS` and rebuild. The routes vanish, the site is static again, and the
free converter is unchanged. Do this after the demand window closes rather than leaving a
payment endpoint running unattended for years — but leave `NEXT_PUBLIC_PAYMENTS_ENABLED`
unset for a month first, so that in-flight checkouts and webhook retries still land somewhere.
