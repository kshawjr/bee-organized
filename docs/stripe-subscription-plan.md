# Stripe + Subscription System — Scope Assessment

**Date:** 2026-05-23 · **Launch:** Tuesday 2026-05-26 · **Status:** read-only investigation, no code changes
**Investigated worktree:** `claude/xenodochial-bassi-1047da` (1 commit behind main; main delta is PersonPanel only, unrelated to billing)

---

## A. CURRENT STATE SUMMARY

**Stripe is not integrated. At all.**

- `package.json` has **no `stripe` dependency**, no `@stripe/stripe-js`, no `@stripe/react-stripe-js`.
- `.env.local` has **no `STRIPE_*` env vars** of any kind.
- Codebase contains **zero** real Stripe SDK calls: no `loadStripe`, no `new Stripe(`, no Checkout redirects, no Elements, no webhook receiver, no `checkout.stripe.com` URLs.
- Every "🔒 Secured by Stripe" / "Powered by Stripe" string is **visual copy only**, with explicit code comments saying "real Stripe Elements coming soon" and "Stripe wiring is Dispatch 3" (`components/BeeHub.jsx:17050`, `:23908`, `:23969`, `:23987`, `:24015`).
- `vercel.json` has only the drip cron — no Stripe webhook route.

### What's real (end-to-end)

| Surface | Reality |
|---|---|
| `subscription_seats` table CRUD via `/api/seats` (GET/POST/PATCH/DELETE) | **Real DB writes**, soft-delete via `status='inactive'`, prorated_cost stored in cents |
| Combined seat-purchase + invite via `/api/seats/buy-and-invite` | **Real**, with rollback (deletes orphan seat if invite insert fails) |
| Tier pricing CRUD via `/api/admin/tier-prices` (GET/PUT) | **Real**, single source of truth in `tier_prices` table |
| `/api/locations/[id]/subscription` PATCH | **Real**, but writes DB columns only (status, payment_source, paid_through_date, billing_notes) — no Stripe side-effect |
| `/api/locations/[id]/complete-onboarding` POST | **Real DB flip** of `subscription_status → 'active'` + `subscription_started_at` stamp + drip-path seeding. No charge. |
| `/api/locations/[id]/launch` POST | **Real DB flip** of `lifecycle_status → 'active'` + `activated_at` stamp + onboarding cache clear. |
| Onboarding Pay step (`components/BeeHub.jsx:9520`–`:10038`) | UI is real (form, prorated math, payment_source branching), submission calls real `/api/seats` + `/api/locations/[id]/complete-onboarding`. Card/ACH fields **collect nothing** — they just gate the click. |
| AddSeatsModal `+ Add seats` flow (`components/BeeHub.jsx:24011`–`:24115`) | **Real seat insert** via `/api/seats` with `prorated_cost`. Comment at `:24015` confirms "No real Stripe yet — Pay just records the prorated_cost on each seat row." |
| Prorated math (`lib/subscription-math.ts`) | **Real and correct**; renewal date hardcoded to **March 1**, day-count proration over 365-day year |
| Co-owner discount (`components/BeeHub.jsx:18388`–`:18396`) | **Real**: 2nd+ owner billed at Hive Manager rate |
| `PastDueBanner` / `PastDuePaymentCard` (`components/BeeHub.jsx:11552`, `:11605`) | **UI is real**, condition is `crmStatus === 'pastdue'` (only set if super_admin manually PATCHes `subscription_status='past_due'`). **`graceDaysLeft = 14` is hardcoded** at `:17777` — no clock, no "days since payment failed" computation. |
| Admin location subscription editor (`components/BeeHub.jsx` ~19603–19810, super_admin only) | **Real**, mirrors PATCH endpoint |

### What's stubbed / fake

| Surface | Reality |
|---|---|
| `processPayment()` (`components/BeeHub.jsx:9978`) | **2.2-second `setTimeout` mock** between form click and the real `/api/seats` call |
| ACH form (account/routing) and credit-card form (`:10182`–`:10230`, `:15393`–`:15512`) | Field inputs collect strings but **nothing is sent anywhere** |
| `BillingHistorySheet` (`:15258`–`:15305`) | Renders a hardcoded `BILLING_HISTORY` array — no API |
| `UpdatePaymentModal` submit | Form is real, but submit handler doesn't call any backend (untraced/no-op) |
| `graceDaysLeft` countdown | Hardcoded `14`; no real timer driven from `paid_through_date` |
| Renewal email / lockout enforcement | None — nothing reads `paid_through_date` to enforce anything |
| `stripe_customer_id` / `stripe_subscription_id` columns on `locations` | Queried in GET only, never written |

### What's completely fake (visual only)

- All "🔒 Secured by Stripe" text — five occurrences, all decoration
- "ACH via Plaid · Cards via Stripe" line at `:15647`
- Credit-card and ACH input UIs in onboarding and `UpdatePaymentModal`
- `BillingHistorySheet` rows

---

## B. LAUNCH-CRITICAL DECISIONS NEEDED (before Tuesday)

For each of the 10 launch locations, the system needs to know:

1. **What `payment_source` does each launch location use?**
   - The 4 valid `subscription-math.ts` values: `'direct' | 'prepaid_corporate' | 'corporate_sponsored'` (the route handler also accepts `'none' | 'corporate' | 'stripe'` for legacy/edge cases — see `app/api/locations/[id]/subscription/route.ts:64`).
   - **If all 10 are `corporate_sponsored` or `prepaid_corporate`** → no Stripe needed Tuesday. The flow already works: seats are created with `prorated_cost = null`, `subscription_status` flips to `'active'`, no money moves.
   - **If even one is `'direct'`** → that owner clicks "Pay" Tuesday and **nothing actually charges**. They'll think they paid. We'll be on the hook for collection.

2. **For the Test Location specifically** — is it `'direct'` with a real card, or `'corporate_sponsored'` (Kevin/HQ eating the cost)? This determines whether we need any Stripe work this week.

3. **Renewal date** — `subscription-math.ts` hardcodes **March 1**. Is that correct for the launch cohort? All 10 launch locations get prorated to next March 1 regardless of when they activate. If anyone needs a different anniversary date, that's a code change.

4. **Past-due policy** — `subscription_status='past_due'` is currently only set manually by a super_admin. There's no automation. The UI shows a 14-day grace banner that is **hardcoded** and doesn't actually lock anyone out. Is this OK for launch (no enforcement) or a blocker?

---

## C. LAUNCH-CRITICAL GAPS (must-fix for Tuesday)

**If all 10 launch locations are corporate-sponsored or prepaid: this list is essentially empty.** The corporate-sponsored flow works end-to-end today — seats get created, subscription flips active, no money moves, onboarding completes.

**If any launch location is `'direct'` with a real card:**

| # | Gap | Complexity |
|---|---|---|
| 1 | Install `stripe` + `@stripe/stripe-js` packages | XS (npm install) |
| 2 | Create Stripe products + prices for each tier (owner/manager/light/readonly) | XS (Stripe dashboard) |
| 3 | Add `STRIPE_SECRET_KEY` + `STRIPE_PUBLISHABLE_KEY` to Vercel env | XS |
| 4 | Wire a Stripe Checkout (one-time payment in `mode='payment'` for prorated charge) into the Pay step's confirm button, replacing the `processPayment()` stub | M — touches `components/BeeHub.jsx:9978` + new server route `/api/billing/checkout`. ~150 LoC. Need to handle return URL → re-trigger `/api/seats` + `/api/locations/[id]/complete-onboarding` post-charge |
| 5 | Capture `stripe_customer_id` / `stripe_subscription_id` on the location row | XS (columns already exist) |
| 6 | Webhook receiver at `/api/webhooks/stripe` for at minimum `checkout.session.completed` to confirm payment before flipping subscription_status | M — ~80 LoC + webhook secret env var + Stripe dashboard webhook config |

**Realistic minimum for Tuesday if `'direct'` is in scope:** ~1 day of focused work (gaps 1–6 above). **More realistic recommendation:** push all 10 launch locations to `corporate_sponsored` and treat real-card billing as Week 2+.

---

## D. POST-LAUNCH STRIPE WORK

When the first `'direct'` owner signs up, these must work:

1. **Real charge at activation** — Stripe Checkout / Elements collecting card, charging the prorated annual amount
2. **Subscription persistence** — create a Stripe `Customer` + `Subscription` (annual recurring), store IDs on `locations`
3. **Renewal handling** — Stripe handles the annual recurrence; we need a webhook (`invoice.payment_succeeded`) to bump `paid_through_date` forward 1 year
4. **Mid-cycle seat changes** — when owner adds a Manager seat in October:
   - Either create a one-time invoice for the prorated remainder + add to next-cycle quantity, OR
   - Use Stripe's proration on the Subscription quantity
   - **Current code stores `prorated_cost` in cents on the seat row** but never bills it. Add real charge here.
5. **Seat removal** — soft-delete works today; need to decide credit/refund/no-action policy and surface it in Admin
6. **Payment failure → past_due** — webhook (`invoice.payment_failed`) flips `subscription_status='past_due'`, kicks off the 14-day grace banner (which needs a real day-count, not the hardcoded 14)
7. **Lockout enforcement** — currently the past-due UI shows a warning but doesn't actually block anyone. Need middleware or page-level check that bounces past-due owners after grace expires.
8. **`UpdatePaymentModal` real submit** — currently a no-op form. Needs to update Stripe `Customer` default payment method.
9. **`BillingHistorySheet` real data** — currently a hardcoded mock. Pull from Stripe `invoices.list` or store invoice rows ourselves.
10. **Cancellation flow** — currently doesn't exist anywhere in the codebase. Owner needs a "Cancel subscription" path; admin needs a "Refund + cancel" path.

---

## E. SCHEMA ASSESSMENT

### Ready

- **`locations`** has all the columns needed for both stubbed and real flows:
  `subscription_status`, `subscription_plan`, `subscription_started_at`, `payment_source`, `paid_through_date`, `deferred_until`, `billing_notes`, `lifecycle_status`, `activated_at`, **`stripe_customer_id`**, **`stripe_subscription_id`**
  (Stripe ID columns exist but are never written — likely added pre-emptively. No migration file in `migrations/` for them, so they're probably from an earlier Supabase-UI change.)
- **`subscription_seats`** (`migrations/subscription_seats.sql`) — `id, location_id, tier, user_id, status, added_at, removed_at, prorated_cost, added_by, notes`. `prorated_cost` column already in cents with the comment *"for audit/Stripe later; null for prepaid/sponsored"*. RLS in place.
- **`tier_prices`** (`migrations/tier_prices.sql`) — `id, display_name, price_annual, description, sort_order, updated_at, updated_by`. Seeded with owner=$550, manager=$400, light=$200, readonly=$50. RLS in place.

### Gaps

- **No `invoices` / `payments` / `billing_events` table** for OUR subscription billing. (The `invoices` table that exists belongs to **Jobber client invoices** — completely separate domain, see `app/api/import/jobber-clients/route.ts:684`.)
- **No `stripe_events` / webhook idempotency table** — Stripe webhooks need idempotent receipt; without this, retries double-charge or double-flip state.
- **No `paid_through_date`-based jobs/triggers** — nothing reads this column to enforce renewals or surface past-due automatically.
- **No migration on disk** for the `stripe_customer_id` + `stripe_subscription_id` columns on `locations`. They exist (the GET route queries them successfully), but the source-of-truth for re-creating the schema is missing. Worth backfilling a migration file before launch for future environments.

---

## F. SUBSCRIPTION LIFECYCLE GAPS

| Event | Today | Gap |
|---|---|---|
| **Onboarding complete** | DB flips `subscription_status='active'` via `/api/locations/[id]/complete-onboarding`. Drip paths seeded. | For `'direct'`: should not flip to `active` until Stripe confirms payment. Today it flips regardless. |
| **Seat added post-onboarding** | Real DB insert via `/api/seats` with `prorated_cost` recorded. | For `'direct'`: no charge. For corporate: no notification to HQ. |
| **Seat removed** | Soft-delete works (`status='inactive'`, `removed_at` stamped). | No credit/refund logic. No Stripe subscription quantity decrement. |
| **Renewal** | `paid_through_date` is a column but nothing maintains it. No cron, no webhook. | For `'direct'`: Stripe Subscription would auto-renew; we'd need a webhook to update `paid_through_date`. For corporate: who reminds HQ to re-up? No mechanism. |
| **Payment failure** | Nothing triggers `subscription_status='past_due'` except manual super_admin PATCH. UI is ready (banner + lockout countdown) but disconnected. | For `'direct'`: needs Stripe `invoice.payment_failed` webhook. |
| **Cancellation** | No UI for owner to cancel. Admin can PATCH `subscription_status='canceled'` but no Stripe-side cancellation, no refund logic, no data-retention policy. | All TBD. |
| **Past-due lockout** | Banner says "14 days until lockout" with hardcoded `14`. No enforcement — past-due owners can keep using the app indefinitely. | Need real day-count + middleware/page-level gate. |
| **Trial periods** | No trial concept anywhere — there's a `'trial'` status in the route's `allowedStatuses` whitelist, but nothing sets or honors it. | If we want trials, build them. Otherwise drop the status. |

---

## G. RISKS + UNKNOWNS

### Kevin needs to confirm

1. **Stripe account state** — does a Bee Organized Stripe account even exist? Live mode or test mode? Are products/prices set up for the four tiers? (No env vars suggest no integration has been attempted.)
2. **Launch cohort payment_source split** — of the 10 launch locations, how many are corporate-sponsored vs prepaid vs direct? **If 10/10 corporate, Tuesday is safe.**
3. **Test Location payment intent** — when Kevin clicks Pay Tuesday on the Test Location with the test card he keeps mentioning, does he expect Stripe to actually charge it? If yes, that's a P0 gap.
4. **Billing cycle** — code assumes annual with March 1 anniversary. Confirm.
5. **Trial periods / free tier** — codebase has a `'trial'` enum value that nothing uses. Intentional placeholder or dead?
6. **Corporate-sponsored billing reality** — how does HQ actually pay corp Bee Organized for sponsored seats? Is that handled outside the app entirely (handshake invoice from HQ → corporate accounts payable)? If so, no in-app work needed; if not, we have an unsolved billing relationship.
7. **Prepaid-corporate period length** — when does prepaid expire? `paid_through_date` is a column but no migration / seed / UI sets it explicitly during onboarding. Needs a default (1 year? until end of franchise term?).
8. **Refund/cancellation policy** — needed before the first `'direct'` cancel even with launch out of scope.

### Unknowns from code alone

- Where the existing `stripe_customer_id` / `stripe_subscription_id` columns came from (no migration file). Probably Supabase UI; worth committing a migration to lock the schema.
- Whether Plaid/ACH ("ACH via Plaid · Cards via Stripe" string at `:15647`) was ever scoped or is pure aspirational copy.
- Whether `UpdatePaymentModal`'s submit was intentionally left blank or got dropped mid-implementation.

### Risks at launch

- **Silent payment "success"**: if a launch owner is on `'direct'` payment_source Tuesday, they click Pay, get the 2.2s spinner, see green, and the location flips to `active`. **No money moves and they don't know.** This is the single biggest hidden risk.
- **Past-due UI fires from manual PATCH only**: if someone accidentally sets `subscription_status='past_due'` in admin, the owner sees a scary banner with a fake countdown. Low-probability/low-impact, but worth knowing.
- **Tier-price edits affect renewals immediately**: a super_admin updating `tier_prices` via Admin doesn't trigger any "are you sure?" gate; existing seats get repriced at next render. No invoice impact today (no real billing), but real cost-of-mistake when Stripe lands.

---

## Recommendation

**Path A (corporate-sponsored launch — recommended):** Confirm all 10 launch locations are `corporate_sponsored` or `prepaid_corporate`. Ship Tuesday as-is. No Stripe work needed this week. Plan a Week 2–3 sprint for the real `'direct'` integration (gaps 1–6 in Section C, ~1 sprint of work) before the first non-corporate owner.

**Path B (direct billing required Tuesday):** Implement Section C gaps 1–6 by Monday EOD. Aggressive but doable — ~1 day. Defer renewal automation, refund flow, real BillingHistory, real UpdatePayment, and lockout enforcement to post-launch.

**Path C (do nothing, accept silent payment risk):** Not recommended. If even one `'direct'` owner activates Tuesday, we either get a no-charge embarrassment or have to manually invoice them through some other channel.
