# Subscription / Billing / Seats / Roles Audit

**Audit date:** 2026-06-17  
**Base commit:** d414443  
**Author:** Internal audit (Claude Code)  
**Status:** Reference documentation  

> This audit maps the complete current state of subscription,
> billing, seats, roles, and pricing infrastructure in Bee Hub.
> Use as a reference when planning co-owner, manager tier,
> multi-location, or Stripe-related work.
>
> Findings here predate any future code changes — refresh the
> audit before making major architectural decisions if 6+ months
> have passed.

---

**Base:** `d414443` (worktree current with `origin/main`). Investigation only — no code changed.

**One-paragraph orientation:** There are **two parallel vocabularies that don't line up** — *roles* (`hub_users.role`: super_admin/admin/owner/lite_user) and *seat tiers* (`subscription_seats.tier`: owner/manager/light/readonly). The whole billing model is real at the DB + math layer but **Stripe is 100% absent** (no package, no SDK, no charges). Manual billing (convert-to-direct + invoice history) is genuinely wired; every "Pay" button is a confirmation-only stub. One location assumes one owner and one user assumes one location, with partial co-owner support already baked into pricing/UI but not the data model.

---

## Section 1 — Schema Map

### `locations` (subscription/billing columns)
**No migration file defines the core status columns** — they live directly in Supabase, so there are **no DB CHECK constraints** on them; allowed values are enforced only in route code. Only peripheral columns have migrations (`onboarding_pass2.sql`, `onboarding_persistence.sql`, `locations_jobber_*.sql`).

| Column | Type | Allowed values (code-enforced) | Written by |
|---|---|---|---|
| `payment_source` | text | PATCH allows `none, direct, prepaid_corporate, corporate_sponsored, corporate, stripe`; invite-owner offers only `prepaid_corporate, corporate_sponsored, direct` | `subscription/route.ts:96`, `convert-billing/route.ts:164` (→direct), `invite-owner/route.ts:369` |
| `subscription_status` | text | PATCH allows `deferred, trial, active, past_due, canceled`. `inactive` is **read** but not in the allow-list (legacy, DB-edit only) | `subscription/route.ts:82`, `complete-onboarding/route.ts:45` (→active), `convert-billing/route.ts:165` (→active), `invite-owner/route.ts:371` (→deferred) |
| `lifecycle_status` | text | `onboarding, active, paused, inactive` (no code validator) | `launch/route.ts:46` (→active), `admin/locations/route.ts:185` (→onboarding), `invite-owner/route.ts:372` |
| `subscription_plan` | text | `owner_annual` seen; no validator | `subscription/route.ts:108`, `invite-owner/route.ts:373` |
| `paid_through_date` | date | YYYY-MM-DD; NULL for sponsored | `subscription/route.ts:100`, `convert-billing/route.ts:166`, `invite-owner/route.ts:370` |
| `deferred_until` | tstz | nullable | `subscription/route.ts:104` only |
| `billing_notes` | text | free-text audit trail | `subscription/route.ts:112`, `convert-billing/route.ts:167` (appends), `invite-owner/route.ts:374` |
| `subscription_started_at` | tstz | stamp on →active | `subscription/route.ts:85`, `complete-onboarding/route.ts:46` |
| `activated_at` | tstz | launch stamp (migration: `onboarding_pass2.sql:29`) | `launch/route.ts:47` |
| `stripe_customer_id` | text | **read-only stub** — selected `subscription/route.ts:21`, never written | — |
| `stripe_subscription_id` | text | **read-only stub** — never written | — |
| `corporate_sponsorship_*_at` | tstz | **dead** — referenced only in a comment (`convert-billing/route.ts:9`); never read/written | — |

> Two schema gaps worth noting: (1) **no migration on disk** for `stripe_customer_id`/`stripe_subscription_id` — they exist in the live DB but the schema source-of-truth is missing; (2) the `corporate_sponsorship_*_at` columns are effectively phantom.

### `subscription_seats` (`migrations/subscription_seats.sql`)
Pool model — each row = one seat, assigned (`user_id`) or unassigned.
- `id, location_id (FK locations ON DELETE CASCADE), tier CHECK IN ('owner','manager','light','readonly'), user_id (FK auth.users ON DELETE SET NULL), status CHECK IN ('active','inactive') default active, added_at, removed_at, prorated_cost int (cents, null for prepaid/sponsored), added_by, notes`
- Indexes: by location; by user (partial, user_id not null); **unassigned-pool** partial index `(location_id, tier) WHERE user_id IS NULL AND status='active'`.
- RLS: read = admin or any hub_user at the location; write = admin or `owner` of that location.

### `billing_invoices` (`migrations/billing_invoices.sql`, shipped today)
- `id, location_id (FK CASCADE), amount_cents int CHECK >0, currency default usd, paid_at, period_start, period_end, source CHECK IN ('manual_conversion','stripe','manual_other'), payment_method, reference_number, memo, recorded_by (FK hub_users), stripe_invoice_id, stripe_payment_intent_id, stripe_charge_id (all NULL until Stripe), created_at, updated_at + trigger`
- Currently inserted **only** by convert-billing (`source='manual_conversion'`, all stripe_* null).

### `pending_invites` (`migrations/invite_tokens.sql` + `pending_invites_corporate.sql`)
- `id, location_id (nullable after corporate migration), email, full_name, role CHECK IN ('owner','admin','lite_user','super_admin'), tier CHECK IN ('owner','manager','light','readonly','admin'), invite_token UNIQUE, invite_expires_at, invited_by, created_at, accepted_at, accepted_user_id`
- Alignment constraint: `tier='admin' ⇒ location_id IS NULL`; franchise tiers ⇒ location_id NOT NULL.
- **Note:** the `role` CHECK has no `'manager'` — confirming there is no manager role (see §2).

### `hub_users` (role-related)
- `role` (no dedicated migration — lives in Supabase), `location_id` (single FK), plus audit columns `invited_by`, `invite_accepted_at` (`invite_tokens.sql:95-97`).

### `tier_prices` (`migrations/tier_prices.sql`)
- `id PK CHECK IN ('owner','manager','light','readonly'), display_name, price_annual int CHECK >=0, description, sort_order, updated_at, updated_by`
- Seeded: owner "Zee Bee" $550, manager "Hive Manager" $400, light "Worker Bee" $200, readonly "Honey Watcher" $50.

---

## Section 2 — Roles & Tiers Inventory

### Roles (`hub_users.role`) — canonical type at `lib/auth.ts:4`
| Role | Meaning | Has a price? | Key gates |
|---|---|---|---|
| `super_admin` | Corporate/dev, sees all | no | only role that can PATCH subscription, invite owner/corporate-admin, restart drips |
| `admin` | Corporate, org-wide | no | `isAdmin()` elevated everywhere; **cannot** run Jobber import (`canRunImport` excludes admin) |
| `owner` | Franchise owner, one location | via owner **tier** ($550) | manages own location's seats/team/drips |
| `lite_user` | Everyone non-owner, one location | via manager/light/readonly tier | read-only by design (but see leak below) |

`isOwnerOrAbove()` (`lib/auth.ts:43`) is **dead code** — used by no route.

### Tiers (`subscription_seats.tier` / `pending_invites.tier`) — priced in `tier_prices`
| Tier | Label | Price/yr | Status |
|---|---|---|---|
| owner | Zee Bee | $550 | live |
| manager | Hive Manager | $400 | live |
| light | Worker Bee | $200 | **deferred — invites 503'd** (`invite/route.ts:40`, `buy-and-invite/route.ts:29`) |
| readonly | Honey Watcher | $50 | **deferred — 503'd** |
| admin | (corporate) | — | invite-only, no seat, location-less |

`VALID_TIERS` differs per route: seats POST = owner/manager/light/readonly; buy-and-invite = manager/light/readonly (no owner); hub_users/invite = +admin.

### The role↔tier translation (the single most important inconsistency)
`roleForTier()` (`invite/route.ts:48-52`): owner→`owner`, admin→`admin`, **everything else (manager, light, readonly) → `lite_user`**. The role is written to `pending_invites.role` at invite time and copied verbatim into `hub_users.role` at accept (`accept/route.ts:93`).

**⇒ There is no `manager` role.** A $400 Hive Manager seat-holder is a `lite_user` at the authorization layer — indistinguishable from a read-only employee. Since nearly every write route blocks `lite_user`, **a "manager" currently has read-only permissions** despite being the priciest non-owner tier. This is the highest-impact finding for a future "Manager tier" feature.

**Display mappings** (`app/_hub-page.tsx`, cosmetic, lossy):
- `mapRole`: super_admin→{super_admin,owner}, admin→{corporate,owner}, owner→{franchise,owner}, lite_user→{franchise,viewer}
- `mapTier`: labels all lite_user as `readonly`, admin as `manager` — ignores the actual `subscription_seats.tier`.

### Secondary permission leak
`lib/crm.ts:162-170` `canReadLocation`/`canWriteLocation` = `isElevated OR same-location` — they **do not exclude `lite_user`**. So lite users (and managers) can POST/PATCH/DELETE on **companies and partners** (`companies/route.ts:53`, `partners/route.ts:59`, etc.), unlike every other write route. Contradicts the read-only model.

---

## Section 3 — State Machine

Three **independent** status fields (launch.route explicitly documents they don't touch each other):

**`subscription_status`** (billing UI, only matters post-launch):
- initial `deferred` (invite-owner / default) → `active` on onboarding pay (`complete-onboarding:45`) **or** convert-billing (`convert-billing:165`) **or** super_admin PATCH.
- `trial`, `past_due`, `canceled` reachable **only via manual super_admin PATCH** — no automation, no Stripe webhook.
- `past_due` → forces Hive read-only + PastDueBar (`BeeHub.jsx:20037,20210`) but **does not block lead intake/drips**; the "14-day grace" countdown is **hardcoded**, no real clock.

**`lifecycle_status`** (the real functional gate):
- `onboarding` (created) → `active` on Launch (`launch/route.ts:46`, stamps activated_at, clears onboarding_state).
- **Drip enrollment is gated on `lifecycle_status==='active'`** (`leads/intake/route.ts:165`) — the single most important runtime gate. Non-active captures lead+touchpoint but does not enroll.
- `paused`/`inactive` are **read but never written by code** — DB-edit only.

**`payment_source`** behavior:
- `direct` — owner pays; convert-billing target; gets prorated math + billing_invoices row.
- `prepaid_corporate` — real `paid_through_date`; convertible.
- `corporate_sponsored` — `paid_through_date` NULL; **stays `deferred`** through the window but still launches; convertible. "Convert to Direct Billing" button shows only for the two corporate sources (`BeeHub.jsx:10986,22323`).

**Notable:** corporate sponsorship-end is never tracked programmatically (the `corporate_sponsorship_*_at` columns are dead); conversion is fully manual.

---

## Section 4 — Pricing & Proration (`lib/subscription-math.ts`)

- **Single source of truth = `tier_prices` table.** Loaded server-side in `_hub-page.tsx`, threaded through `TierPricesContext` in BeeHub.jsx, consumed at ~10 sites with `DEFAULT_TIER_PRICES` as fallback. The old two-disagreeing-copies problem is **resolved** — no hardcoded price tables remain in BeeHub.jsx.
- **Renewal: hardcoded March 1** (`RENEWAL_MONTH=3, RENEWAL_DAY=1`), 365-day year. `prorateToNextRenewal = round(annual × daysUntilRenewal/365 × 100)/100`. Everyone prorates to next March 1 regardless of activation date.
- **Co-owner rule** (`calculateOwnerSubtotal:46-55`): 2nd+ owner bills at the **manager** rate (`ownerPrice + (n-1)×managerPrice`). The cap-at-2 is **not** in the math — it's a UI-only `SEAT_MAX('owner')=2` (`BeeHub.jsx:20687`).
- **Editable via Admin → Pricing** (`PUT /api/admin/tier-prices`, super_admin/admin). No confirmation gate; edits reprice all existing seats at next render.
- Proration is **computed, displayed, and persisted** (`prorated_cost` in cents on each seat) but **never charged**.
- ⚠️ The test file `subscription-math.test.ts` has `@ts-nocheck` and **no runner is configured** (no jest/vitest in package.json) — those tests never execute.

---

## Section 5 — Seat Lifecycle

**CREATED** — four insert sites, all service-role after app-auth:
1. Onboarding Activate — owner self-assigns one `owner` seat (`seats/route.ts` POST, driven by `BeeHub.jsx:11457`); skipped entirely when prorated=0 (corp-sponsored, seat pre-allocated).
2. "+ Pre-buy seats" (`AddSeatsModal`) — bulk unassigned seats, owner-excluded, server caps 50.
3. buy-and-invite — seat + invite atomically, manager/light/readonly only, **hard-deletes the seat if the invite insert fails** (no phantom charge).
4. invite-owner — super_admin only, corp-sponsored owner seat (`prorated_cost=0`), **reuses** an existing unclaimed owner seat (idempotent).

**INVITE** — seats are **not** pre-claimed (FK to auth.users can't bind a pre-auth invitee). Invites are counted against the pool by `(location, tier)`; `availableSeats − pendingInvites < 1 ⇒ 409 no_available_seats` (`invite/route.ts:311-348`).

**CLAIMED** (`accept/route.ts`) — on Google sign-in matching the invite email: insert hub_users (role = invite.role), then claim ONE matching unassigned active seat ordered by `added_at` → set `user_id` (`:145-148`); skipped for `tier='admin'`. Mark invite accepted last (retry-safe).

**REASSIGNED** — `PATCH /api/seats {id, user_id}` supports assign/reassign/unassign, **but no UI ever passes a non-null new user_id**. The only PATCH caller is `removeMember`, which sets `user_id:null`. So user-to-user transfer exists in the API but is unwired.

**RELEASED / DELETED**:
- Release = member removal sets `user_id:null` (seat stays `status='active'`, billable, re-claimable). The only end-to-end release path.
- Soft-delete `DELETE /api/seats` (status=inactive) is **super_admin-only and called by no UI** — there is **no owner-facing way to reduce paid seat count**.
- hub_users DELETE doesn't touch seats; owners can't remove themselves or another owner.

**UI surfaces** (all in `BeeHub.jsx`): onboarding Activate; onboarding Invite-Team; Settings→Billing "+Pre-buy seats"; Settings→Team "+Invite" + "Remove"; revoke pending invite; Admin→Locations "Invite Owner".

---

## Section 6 — Add-ons & Extras (what bills beyond base)

There is no separate "add-on" concept — **everything is a seat**. Cost beyond the base owner seat:
- **Additional owner (co-owner)** — 2nd owner seat at the manager rate ($400), capped at 2 in UI.
- **Manager seat** — $400/yr each (live).
- **Light/Readonly seats** — $200 / $50, **currently disabled** (invites 503'd).
- No SMS/texting add-on, no premium feature flags, no usage-based billing anywhere. "Zee Bee" is the owner *tier display name*, not a separate premium plan.
- All prices in `tier_prices`. Nothing is actually *charged* — `prorated_cost` is recorded only.

---

## Section 7 — Co-owner Readiness (2+ owners per location)

**Already supports it:**
- Pricing math (`calculateOwnerSubtotal`) + UI stepper (max 2, "2nd seat $400/yr").
- invite-owner is co-owner-aware: existing owner → `409 {requires_confirmation, owner_exists}`, proceeds with `force:true` (a **soft warning, not a block**).
- hub_users DELETE already blocks removing "another owner."
- hub_users/invite path accepts `tier='owner'`.

**Would break / needs work:**
- **Seats POST has no owner cap** (`seats/route.ts`) — would happily create a 3rd owner seat; the "max 2" is client-only.
- `owner-status` returns only the earliest owner (`limit(1).maybeSingle()`); `ownersByLoc` in `_hub-page.tsx:335` is first-owner-wins → 2nd owner invisible in admin roster.
- Email/drip helpers (`stage-emails.ts:220`, `welcome-email.ts:109`, `drip-send.ts:139`) pick "the owner" non-deterministically with 2 owners.
- Onboarding is a **single-owner journey** keyed on the signed-in owner with one shared `onboarding_state` blob; a 2nd owner joining an active location inherits completed onboarding (no co-owner branch).
- Copy hardcodes "One per location" (`BeeHub.jsx:20641`).

---

## Section 8 — Multi-Location-Owner Readiness (1 user → N locations)

**Fundamentally unsupported.** `hub_users` has a single `location_id` scalar; there is no junction table and **no location switcher anywhere** (grep for switchLocation/LocationSwitcher = nothing).

Hard assumptions that would break:
- `canAccessLocation` (`auth.ts:52`), `canReadLocation`/`canWriteLocation` (`crm.ts:162`), and every route's caller check are scalar `location_id ===` comparisons.
- Server "current location" = `hubUser.location_id` (`_hub-page.tsx:224`); all franchise data fetches (users, leads, recycle bin, partners/companies) `.eq(..., hubUser.location_id)`. The `locFilter`/`all` mechanism is **admin-browse only**; `locationSwitcher` prop is never passed.
- Role is **global per user**, not per-membership — can't be "owner at A, manager at B."
- **Accept route silent drift** (`accept/route.ts:79-153`): accepting a 2nd-location invite short-circuits the hub_users insert (keeps original location_id) **but still claims a seat at the new location** → an orphaned seat at B owned by a user who can't access B. Neither overwrites nor fails cleanly.

Enabling N locations = `hub_users↔locations` junction (with per-membership role/tier) + current-location selector (server + UI) + rewriting every scalar check. The seat/invite layer is already per-location, so only the membership model needs restructuring.

---

## Section 9 — Stripe Readiness

**Verdict: 100% stubbed.** No `stripe`/`@stripe/*` in package.json, no SDK calls, no webhook route, no env vars. `stripe_*` columns on `locations` and `billing_invoices` are read-but-never-written placeholders.

All "🔒 Secured by Stripe" / "ACH via Plaid · Cards via Stripe" / "•••• 4242" are decorative; comments explicitly say "Real Stripe Elements drop in here post-demo" and "Stripe integration coming soon."

**What IS real now** (advanced since the 2026-05-23 plan doc):
- `billing_invoices` table + structured insert from convert-billing.
- `BillingHistorySheet` now does a **live fetch** of `/api/locations/[id]/invoices` (the plan doc's claim that it's a hardcoded mock is **stale**; the old `BILLING_HISTORY` array is now dead code at `BeeHub.jsx:16996`).
- ConvertBillingModal + convert-billing route write real DB state.

There's a detailed roadmap already in `docs/stripe-subscription-plan.md` (Sections C/D) — gaps: no `stripe_events`/idempotency table, no renewal job reading `paid_through_date`, no real charge at activation, no past-due automation/lockout, no cancellation flow.

---

## Section 10 — Mid-Cycle Changes

| Change | Status |
|---|---|
| Add seat after activation | ✅ wired (AddSeatsModal + buy-and-invite), records `prorated_cost`, **no real charge** |
| Release seat (unassign user) | ✅ wired via member removal (seat stays active/billable) |
| Reduce paid seat count (deactivate) | ❌ API super_admin-only, **no UI** |
| Reassign seat user→user | ❌ API supports, **no UI** |
| Change plan / tier of existing seat | ❌ doesn't exist |
| Recalculate/charge on seat change | ❌ proration computed + stored, never billed |
| Convert corporate→direct | ✅ fully wired (the newest feature) |
| Cancellation | ❌ super_admin can PATCH `canceled`; no flow, no refund logic |

---

## Section 11 — Recommendations

Complexity is rough eng effort (S≈hours, M≈1–3 days, L≈1 sprint, XL≈multi-sprint).

| Scenario | Complexity | Prerequisites | Unlocks | Doesn't address |
|---|---|---|---|---|
| **Co-owner (#1)** | **M** | Add server-side owner cap in seats POST; make owner-status/`ownersByLoc`/email helpers multi-owner-aware (designate a "primary owner"); co-owner onboarding branch | True 2nd owner with $400 billing (math already done) | Doesn't need a data-model change — owner is already a tier |
| **Manager tier (#2)** | **M–L** | **Introduce a real `manager` role** (currently collapses to lite_user) — DB role CHECK, `roleForTier`, accept route, and a permission matrix for what manager can do vs owner; close the crm.ts lite_user leak while you're there | Functional middle tier matching the $400 price | Pricing already exists; this is purely an authz build |
| **Multi-location owner (#3)** | **XL** | `hub_users↔locations` junction with per-membership role/tier; location switcher (server+UI); rewrite all scalar `location_id===` checks; fix accept-route drift | One user across N locations | Touches nearly every route + every data fetch — biggest item |
| **Multi-payer (#4)** | **L** | Decide model (one location, multiple payment sources/invoices?); needs billing_invoices payer attribution + Stripe customers per payer | Split billing | Depends on Stripe landing first |
| **Record arbitrary payment (#A)** | **S** | Generalize convert-billing's invoice insert into a standalone "record payment" route (source=`manual_other` already in the CHECK) | Manual receipts for any payment without forcing a billing conversion | — |
| **Charge for seat add (automation)** | **M** | Stripe core (below) + wire AddSeatsModal/buy-and-invite to a real charge using the already-stored `prorated_cost` | Real money on seat adds | Needs Stripe first |
| **Real Stripe billing** | **L (core), XL (full)** | package + keys + products/prices; Checkout at activation; `/api/webhooks/stripe` + idempotency table; write stripe_* columns; renewal webhook → bump paid_through_date; past-due automation + real lockout; cancellation/refund | Actual revenue | Renewal/past-due/cancel are each their own slice |

**Suggested sequencing:** Manager tier (#2) and Co-owner (#1) are independent of Stripe and unblock the most immediate product value — do those first. "Record arbitrary payment" (#A) is a quick win on top of today's billing_invoices. Real Stripe is the prerequisite for any *automated* charging (seat-add automation, multi-payer). Multi-location (#3) is the big architectural lift — sequence it deliberately, on its own.

---

## Section 12 — Open Questions (product decisions before code)

1. **Manager = role or just a price?** Today a manager is a read-only lite_user. Do you want a real permission set for manager (between owner and lite), or keep it cosmetic? This blocks both #1 and #2.
2. **Co-owner semantics:** is the 2nd owner a true equal, or an "elevated manager with owner permissions" (which is what the pricing comment says)? Determines whether co-owner needs the full owner permission set or a capped one.
3. **Which "owner" is authoritative** for emails/drips/notifications when there are 2? Need a "primary owner" concept or per-lead assignment.
4. **Should onboarding re-run / branch for a co-owner** joining an active location, or should they skip straight in?
5. **Multi-location:** is the target one *person* owning multiple locations, or a corporate user managing many? (Admins already see all — if the need is oversight, that may already be covered without the junction-table lift.)
6. **Light/Readonly tiers** are coded but deferred (503'd). Re-enable, or remove?
7. **Renewal anniversary** is hardcoded to March 1 for everyone. Correct, or do locations need individual anniversaries? (Affects proration + future Stripe subscription setup.)
8. **Past-due policy:** the 14-day grace is fake and enforces nothing. What should actually happen when payment fails / lapses?
9. **Corporate-sponsored end-of-life:** the tracking columns are dead and conversion is fully manual. How does HQ actually get reminded/billed, and should the app track sponsorship expiry?
10. **`trial` status** exists in the allow-list but nothing sets/honors it — build trials or drop it?
11. **Seat-count reduction:** owners can release a seat (back to pool, still billable) but can't *remove* one. Intended, or should owners be able to lower their paid count (with refund/credit policy)?
12. **Stripe account reality:** does a Bee Organized Stripe account exist with products/prices for the four tiers? (No env vars suggests no integration has ever been attempted.)

---

## Companion documents

- [`docs/stripe-subscription-plan.md`](stripe-subscription-plan.md) — Stripe + Subscription System scope assessment (dated 2026-05-23, pre-launch). Partially superseded by the `billing_invoices` work shipped in commits c6a36c0 / d308639 / d414443 (e.g. `BillingHistorySheet` is now a live fetch, not a mock), but its Stripe gap analysis and launch-decision framing (Sections C/D) remain the current roadmap reference.
