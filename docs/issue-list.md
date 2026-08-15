# Issue list

**Living list.** Rebuilt 2026-08-15 from [`docs/issue-audit-2026-08-15.md`](issue-audit-2026-08-15.md),
which is the evidence every line below rests on. Do not edit the audit; it is a
dated snapshot. Edit this file.

**Numbers in this file replace the numbers in the original tickets.** Where a
line says `RE-COUNT:`, the ticket's own figure is wrong and must not be quoted.

**Evidence base:** repo read at `origin/main` @ `6edc129`, live production
queries against Supabase project `pcuycyelxxkxahlxdewl`, ClickUp list
`901111225249`. Read-only.

**Sections:** [NEW](#new) · [Affecting someone right now](#affecting-someone-right-now) ·
[Latent](#latent) · [Active](#active) · [Killed](#killed) · [Unknown](#unknown) ·
[Not code](#not-code) · [Decided](#decided) · [Weakest calls](#weakest-calls)

---

## NEW

Six findings from the audit that were not on the list and should be. Numbered
here for the first time; none has a ClickUp id yet.

### 297 — `public.hub_users` has RLS disabled entirely
Supabase's advisor flags it **critical**: 27 rows of user and role data readable
and writable by anyone holding the anon key. This is the opposite failure from
[269](#269) and strictly worse. Remediation SQL exists, but enabling RLS without
policies would lock the table — **policies must be designed before any `ALTER`.**
Highest-severity item on this list.

### 298 — A `location_id` named `disposable-stripe` took a real $550 subscription
`sub_1Tzk7j…`, charged 2026-08-01, `paid_through=2027-08-01`. Money landed
against a placeholder id with no corresponding `locations` row. Needs a person,
not a patch — see [Not code](#not-code).

### 299 — `sync_log.landed_status` is mis-set on non-Jobber events
3 of the 9 `not_landed` rows are actually successes: a `PROPERTY_UPDATE` that
synced fine (Seattle 8/5) and two `STRIPE_PAYMENT subscription_create` rows
(Carmel 8/4 and 8/1). The 8/5 digest pushed `:warning: 1 Jobber event DIDN'T
LAND — Carmel: Unknown record — STRIPE_PAYMENT` to Slack — a false alarm to a
real channel. **This inflates every not-landed count in the product, including
[264](#264)'s.**

### 300 — `job_visits` is empty
0 rows, while `engagement_assignees` carries 2,553. The crew-sync target table
has never received a row. Silently invalidates [174](#174), [288](#288), and any
belief that crew assignment reaches Jobber at all.

### 301 — 35 locations sit in `lifecycle_status='onboarding'` against 20 active
**RE-COUNT: 35, not nine.** [257](#257)'s text assumes an exposure of nine
locations. The forward-facing hole is 35 locations wide.

### 302 — Five tables carry schema and RLS but zero rows
`payments`, `notes`, `location_jobber_users`, `import_staging`,
`import_location_fetch`. Either dead scaffolding to remove or wiring never
finished — unresolved either way.

---

## Affecting someone right now

Ten items, ordered by how directly a real person is hit today.

### 230 — Seat Removals card 403s for corporate
Corporate (Leslie) loads the Admin Dashboard and `<ProcessRemovalsCard />` fires
a 403 every time. `BeeHub.jsx:32929` renders it inside
`AdminDashboard({..., role, ...})` with **no role gate** — only "Pricing" is
gated — while the route itself 403s non-`super_admin`. 226 step 8 removed the
quick-action but left the card on the shared dashboard.

### 255 — Booking link paints as saved when the write failed
`BeeHub.jsx:22076` calls `updateProfile('bookingLink', v)` **before** the fetch.
Its own sibling `persistProfileField` documents the opposite policy ("we paint
ONLY after the write lands"). Consequence: `{{owner_booking_link}}` never
resolves and every booking-link send is held indefinitely.

### 252 — Merge-tag holds cover 2 of 14 tags · ClickUp `868krpyk4`
`digest_runs` carries `rate_missing` and `booking_link_missing` counters and has
posted "2 locations on rate-quoting paths with NO RATE (sends held)". There is
**no equivalent for the other 12 tags** — emails go out with holes in them and
nothing is recorded.

### 257 — Manual-source leads never enrolled · ClickUp `868kjfrje`
**RE-COUNT: 65, not 31.** 65 manual-source pre-activation leads with no drip and
no welcome, across 11 locations, newest Southeast Nashville 2026-08-14. The
backfill decision is settled (see [Decided](#decided)); the **forward gap is
live**, and per [301](#301) it is 35 onboarding locations wide, not nine.

### 253 — Welcome emails never reach the timeline · ClickUp `868krpyku`
`timeline/route.ts:128-131` returns `welcome_email_*` as bare timestamps; the
fork/template block (`:89-120`) walks only `scheduled_stage_emails` keys. Owners
can now edit welcome copy (240 step 8b) and the timeline has never displayed it
in any form.

### 249 — Feedback arrives without screen/path
`feedback_items_context.sql` shipped (`a86b258`) but only 3 of 63 items carry
context, and the two newest (8/12 22:29, 8/13) are NULL — `FeedbackModal`
doesn't send it.

### 258 — Locations read as subscribers Stripe has never heard of · ClickUp `868kjfrfh`
**RE-COUNT: 5, not 9.** 20 active locations; 15 carry both `stripe_customer_id`
and `stripe_subscription_id`. Missing: **Omaha, Portland, Scottsdale, Seattle,
Test Location** — 4 real + 1 test — while real charges flow for the other 15.

### 234 — Owner invites are signed by Kevin
`lib/invite-email.ts:12-17` — owner and corporate invites send as
`Kevin Shaw <admin@beeorganized.com>`, called from `/api/seats/buy-and-invite`
and `/api/hub_users/invite`, both owner-reachable. An owner inviting their own
manager sends mail signed by someone else.

### 264 — Unattached invoice on a deal card · ClickUp `868kjfrv7`
**RE-COUNT: 1, not five.** 9 `not_landed` rows total; only 3 say "engagement
unresolved" and all 3 are the same KC invoice `…MTY1MTkwMTE2` (7/23). The 2
Portland rows carry no unresolved reason. 0 in the last 7 days. That one deal's
totals and stage are wrong on the card. See [299](#299) — the surrounding count
is inflated by mis-set `landed_status`.

### 291 — Fleet-wide assignee data is fabricated · ClickUp `868kdy5fm`
**RE-COUNT: 14,358, not 2,562.** 17 of 20 locations have exactly one distinct
assignee across all leads. **Premise now false:** intake writes `assigned_to`
deliberately ("first assignee, legacy compat"), so the ticket's Part 1 blanket
null-out would fight a live writer — see [Decided](#decided). What remains real:
the data is fabricated and blocks any honest "unassigned" signal.

---

## Latent

Real, evidenced, nobody hit today.

- **265 — 401 intake submissions are unanswerable** · `868kjfrrp` — *narrowed.*
  **Shipped:** every *authenticated* outcome writes a `sync_log` row, plus
  unknown-key detection (`KNOWN_INTAKE_KEYS` / `unknown_keys=`).
  **Remains:** 401s are deliberately unlogged, so a bad-API-key submission
  leaves no trace. This is exactly the Katie Swann shape — see [293](#293).
- **267 — Zoho null-clears never propagate** · `868kawwf0` — `lib/dual-write.ts:76-80`:
  `if (payload.stage)`, `if (payload.source)`, `if (payload.jobber_client_id)`,
  `if (payload.assigned_to)` — falsy skips, so clears never reach Zoho.
  Survivor of cluster A; [268](#killed) `868kaxm3d` combined into it.
- **269 — RLS silent-zero** · `868kawwuq` — the "done" ClickUp `868kaxm23` is a
  dup-closure *pointing at this ticket*, explicitly "not resolved". No
  demonstrated user-facing path. Contrast [297](#297), the opposite failure.
- **271 — Dead `PARTIAL` invoice branch** · `868kbc91r` — `jobber-import.ts:1373`
  still branches on `status === 'PARTIAL'`; prod `invoices` are paid 5,956 / sent
  49 / bad_debt 7, **zero** `partial`. Cosmetic dead code.
- **275 — Auth host is the raw Supabase domain** · `868kbf7g2` —
  `pcuycyelxxkxahlxdewl` is the live auth host users see. Cosmetic, and
  unfixable from the repo — see [Not code](#not-code).
- **276 — No Jobber reconciliation cron** · `868kax0tz` — **RE-COUNT: 50, not 16.**
  50 `no_valid_jobber_token` (last 7/13) plus 20 `jobber_reauth_required` (last
  7/28), and no reconciliation cron among `vercel.json`'s six entries. Survivor
  of cluster B; [280](#killed) `868kax0x2` contributes the acceptance test it
  lacks — a per-location, per-type Jobber-vs-Bee-Hub count diff — which should
  become 276's first run, scoped to **20 active locations, not 3**.
- **281 — View-as fidelity** · `868kaxm20` — *narrowed.* **Shipped:**
  instrumentation at `BeeHub.jsx:35853`, `logViewAs` with
  `enter:open-picker` / `enter:confirm` / `exit:restore` plus state deltas.
  **Remains:** console-only — no captured event, and therefore no fix.
- **284 — Destructive inbox actions** · `868kaxm2z` — *narrowed.* **Shipped:**
  the 6s undo (`InboxScreen.jsx:659-694`, `6000` on junk and on bulk remove).
  **Remains:** confirm-first is not built.
- **285 — Assigned To has no edit affordance** · `868kbf90h` — renders as
  pills/labels (`BeeHub.jsx:3292`, `:10344`); no pencil-edit pattern.
- **289 — Stage vocabulary is mixed in prod** · `868kaxm2b` — Nurturing 10,141 /
  Closed Won 2,623 / New 739 / Final Processing 737 / Estimate Sent 147 / Job in
  Progress 145 / Request 72 / Attempting 3.
- **290 — `leads.client_status` is four vocabularies plus NULL** · `868kaxm27` —
  12,364 NULL, plus 'Nurturing' 1,322, 'Client' 843, 'Active' 75, 'no_contact' 2,
  'New' 1, while every lens uses `deriveClientStatus`.
- **292 — `sender_reply_to` is unreachable** — *trivial.* A server writer exists
  (POST `/api/locations/[id]/project-type-senders` accepts `sender_reply_to`) but
  no UI supplies it — all 5 prod rows NULL; `resend.ts:198` falls back to the
  location reply-to. Flagged as a weak KEEP — see [Weakest calls](#weakest-calls).
- **229 — Nothing prevents server code reaching the client bundle** — no
  `import 'server-only'` anywhere in `lib/` or `app/`.
- **231 — Orphaned components in `BeeHub.jsx`** — **RE-COUNT: 18, not ~24.**
  AccountEditableRow, AddressRow, AttentionCard, CompanyAddressSection,
  CompanyEditRow, ContactFieldRow, DripSection, ExpandableAttentionCard,
  FollowUpReminders, ListEditModal, PartnerEditRow, PlaceholderScreen,
  ProjectTypeEditModal, QuickNoteInput, SourceInlineField, StatCard,
  TierEditModal, UpdatePaymentModal — plus `CustomPathBuilder`, retained-unmounted
  by comment. 37,056 lines / 161 components.
- **254 — No server-side ordering enforcement on drip delays** — verbatim in
  `lib/beta-emails-timing-240.test.tsx`: "Nothing server-side enforces an
  ordering. The route checks only `Number.isFinite(delay_days) && delay_days >= 0`."
  The UI holds the floor.
- **174 — Crew sync has never written a row** — `job_visits` 0 rows while
  `engagement_assignees` has 2,553. See [300](#300).
- **180 — Failure alerts ignore `paid_through`** — no `paid_through` reference in
  `lib/failure-alerts.ts` or the cron route. 0 locations are past
  `paid_through_date` today (all 2027+), so nothing fires yet.
- **176 — Mid-term seat proration unproven** — `lib/seat-stripe-sync.ts` /
  `seat-cost.ts` exist with unit tests, 26 seats live, but no evidence a real
  proration ever executed against Stripe.
- **177 — No Stripe test-clock harness** — nothing in `scripts/` or `lib/`.
- **179 — `BeeLoader` on the wrong wait** — wired to the Jobber-connection check
  screen (`BeeHub.jsx:33011`), not the send-to-Jobber wait.
- **17 — No assignment-rule engine** — `assignIncomingLead` resolves
  owner-by-project-type only.
- **54 — No bulk add-to-network** — `/api/leads/[id]/network` is single-lead.

> **176 · 177 · 179 · 180 · 17 · 54** are judged from *absence of code*, not from
> a reproduction. Weaker evidence than the rest of this section — see
> [Weakest calls](#weakest-calls).

---

## Active

Process, decision, or record. Not bugs.

### 22 — Visual pass on Settings
246 steps 1–3 shipped the structure (sidebar, New-leads rebuild, orphan toggle).
The visual pass is not done.

### 247 step 3 — Import the ClickUp shortlist
> ⚠️ **WARNING — this audit supersedes the ClickUp shortlist.**
> **17 of its proposed items are now killed or dissolved** (14 KILL + 3 COMBINE
> among the ClickUp-carrying tickets). **Redo the selection against this file
> before importing anything.** Importing the shortlist as it stands would
> re-open work the audit already closed with evidence.

No ClickUp integration exists in the repo — one copy-block comment at
`BeeHub.jsx:32307`. This is a planning task; nothing falsifies it.

### 248 step 2 — Daily brief cron
**NOT BLOCKED.** [279](#killed) is killed: `SLACK_WEBHOOK_URL` **is set**, proven
by `digest_runs` rows carrying `posted: true` and full message text. Step 1
(`.claude/skills/bug-sweep/SKILL.md`) exists; there is no brief cron among
`vercel.json`'s six entries. Ready to build.

### 282 — Record of a decision · ClickUp `868kjfrwz`
The ticket says so itself: "Keep this open as the record of the decision, not as
a build."

### 286 — Scheduled desktop task · ClickUp `868kc4mc3`
No scheduled desktop task artifact in the repo or `.claude/`. Needs a person to
set one up — see [Not code](#not-code).

### 288 — Crew-assignment behavior undecided · ClickUp `868kbc91t`
A genuine unmade product decision. Note that `job_visits` has **0 rows** — the
behavior being decided has never run. See [300](#300).

---

## Killed

**RE-COUNT: 20 killed, not 17.** The figure **17** is the count of
*ClickUp-carrying removals* — 14 killed tickets that hold a ClickUp id, plus the
3 combined/dissolved ones (268, 280, 287). That is the number [247 step 3](#247-step-3--import-the-clickup-shortlist)
must warn about. The killed count itself is 20, because 256, 227, 241, 242, 243
and 245 carry no ClickUp id.

**Weakest-flagged:** ⚠️ marks a verdict the audit itself called low-confidence.
There are **five** such killed items — 260, 256, 262, 242, 227 — not six. The
other flagged-weak verdicts (265, 292, and the 176/177/179/180/17/54 group) are
KEEPs and live in [Latent](#latent). Full text in [Weakest calls](#weakest-calls).

### Killed with a ClickUp id (14)

| # | ClickUp | Evidence that killed it |
|---|---|---|
| 259 | `868kjfrc0` | Webhook is live: 36 `stripe_webhook_events`, 16 `billing_invoices`, `sync_log` shows `STRIPE_PAYMENT … subscription_create … $550.00` (Carmel 8/4). Design moved to Checkout Sessions (`app/api/locations/[id]/checkout`) on `stripe_price_id`; `payment_link_url` is vestigial. |
| ⚠️ 260 | `868kjfrwq` | **RE-COUNT: exactly 70, unchanged, zero since 2026-07-28** (18 days) while traffic ran 1,628 landed rows in 7 days. The ticket's claim that `c7944f4` "won't move these numbers" is **falsified** — failures stop at that 7/30 fix. |
| 261 | `868kew1xa` | All three bugs fixed: `writeLoopShouldYield(wrote, cap, timeLow)` (`jobber-import.ts:418`); auto-continue covers `writing` (`BeeHub.jsx:12607`, `:17317`); sweeper rewritten (`lib/import-continuation.ts`). Prod: 24 completed imports, latest 2026-08-14; every `writing`-phase failure ≤ 2026-07-23. |
| ⚠️ 262 | `868kbduc5` | **RE-COUNT: zero.** `status='pending' AND occurred_at<=now()` returns 0 rows. All 7 pending touchpoints are Re-engage, dated 2026-10-09 → 2026-11-27. The "review-requested + satisfaction are past-due" premise is wrong — those carry `done`/`sent`/NULL. |
| 263 | `868kjfrwj` | Shipped `640b091`: `app/api/webhooks/resend/route.ts`, Svix-verified, hard bounce/complaint → drip stop gated on `email_kind='drip'`. Live: 21 rows `delivery_status='bounced'` (20 lead_notification, 1 drip), last 2026-08-13. |
| 266 | `868kawwmh` | `resolveBetaReadOnly` / `isReadOnlyFranchiseRole` in `components/hive/shared/betaGate.js` cite this ticket id; `readOnly` threads through 29 hive files; `HiveShell.jsx:219` implements the mode; `lib/read-only-access.ts` enforces server-side. |
| 270 | `868kbc91q` | `jobber-import.ts:1203-1213` maps `quoteStatus` via shared `mapQuoteStatus` / `quoteStatusStampsApproval`. Prod quotes: approved 4,099 / archived 1,774 / sent 348 / draft 14 / changes_requested 3. |
| 272 | `868kaxm3a` | `profile/route.ts:21` — "Was a hard `.range(0, 49)`"; now `REFERRED_US_CAP` with `count:'exact'`, pinned by `lib/beta-reverse-referral.test.tsx`. |
| 273 | `868kaxm39` | `referred_by_missing` is computed and returned by `/api/clients/[id]/profile` (`:205`, `:241`) and `/api/engagements/[id]` (`:206`, `:250`); pinned by two tests. |
| 274 | `868kaxm2j` | "Re-sync from Jobber" is live and enabled in Settings → Manage connection (`BeeHub.jsx:17199`), plus "Try again" on error. 24 imports completed, latest 2026-08-14. |
| 277 | `868kjfrwg` | Fixed by `e8948e3`. `drip-send.ts:325-337` stamps `email_kind:'drip'` + `lead_id` + `lead_name`; `:413` writes the Timeline touchpoint on success. Prod: 143 rows `email_kind='drip'`. |
| 278 | `868kax2x7` | All three phases live — Phase 3 proven by `digest_runs` (79 rows, `posted:true`, latest 2026-08-05 with rendered Slack payload). |
| 279 | `868kax70g` | `SLACK_WEBHOOK_URL` **is set** — `digest_runs` rows show `posted: true` and full message text. This is what unblocks [248 step 2](#248-step-2--daily-brief-cron). |
| 283 | `868kc51yk` | All three pieces shipped — PersonCard retired, `openPerson → openClient` (`HiveShell.jsx:374-381`); "Open this lead in Bee Hub →" button (`lead-notification-email.ts:257-267`, `:377`); `?next=` with open-redirect guard (`lib/auth.ts:10-18`). |

### Killed with no ClickUp id (6)

| # | Evidence that killed it |
|---|---|
| ⚠️ 256 | `/api/leads` POST does enroll: `applyDripSideEffects` + inline `sendDripStep` on `stage==='New'` (`route.ts:378-395`); intake `sync_log` rows carry `drip_enrolled=true/false` as the record. |
| ⚠️ 227 | `location.locationId` appears nowhere in the tree; the admin roster is built by `lib/seat-roster.ts` (`buildSeatRoster` / `tallySeatStates`). |
| 241 | Intentional, not a skip: `jobber-import.ts:992` writes `paused: true` so historical clients can't be drip-enrolled; pinned by `lib/email-send-integrity.test.ts`. |
| ⚠️ 242 | Filter drops nothing: 77/77 `drip_path_steps` are `channel='email'`, 3/3 SMS templates are `is_active=false`, and the locked accordion was replaced by `TextsComingSoon` (240 step 6, `BeeHub.jsx:23150`). |
| 243 | Established; corroborated by `201407c` and `lib/beta-drip-never-enrolled-243.test.ts`. |
| 245 | Established; [253](#253--welcome-emails-never-reach-the-timeline--clickup-868krpyku) is its replacement. |

### Combined / dissolved (3)

| # | ClickUp | Result |
|---|---|---|
| 268 | `868kaxm3d` | **→ [267](#latent).** Same truthiness guard captured twice; adds nothing 267 lacks. Cluster A survivor 267 carries the problem statement, user-impact note, and fix direction. |
| 280 | `868kax0x2` | **→ [276](#latent).** Cluster B. 280 is the one-time proof (per-location, per-type Jobber-vs-Bee-Hub count diff); 276 is the durable cron. 280 becomes 276's first run. Scope is **20 active locations, not 3**. |
| 287 | `868kawx6n` | **Dissolved, not carried.** 7 of its 9 "older deferred items" are now separate live tickets (289, 269, 284) or verified dead (272, 273, 274, plus two ClickUp-done). Unique content preserved below so it isn't lost. |

**Salvaged from 287 before dissolving:**
- Palm Beach / Portland owner-view smoke test — still to do.
- The 21 `$0` Closed-Won rows — data note, unexamined.
- View-as fidelity notes — folded into [281](#latent).
- Build-prompt base hashes are unreliable — a process note, and it happened
  again during this audit.

### The four "done" ClickUp overlaps

| ClickUp | Result |
|---|---|
| `868kaxm23` RLS silent-zero | **Not a fix.** Body reads "Closing this one as a dup — not resolved". [269](#latent) stays open. |
| `868kax0tg` "Jobs not moving" | Genuinely resolved (user-confirmed, `bc8e310` + backfills). **Does not cover [276](#latent)** — 276 names itself the separate durable mechanism. |
| `868kaxm38` Snooze badge in Classic | Done; Classic is retired (`lib/beta-classic-retired.test.tsx`). No open twin. |
| `868kaxm1y` Overlay green literals | Done; survives only as a stale line inside 287's grab-bag. |

---

## Unknown

Not judgeable from the repo and production alone. Each carries what would settle it.

### 293 — Katie Swann's Portland lead · ClickUp `868kjfrn5`
**Narrowed, not resolved.** Intake `sync_log` logging has been live since
2026-07-10 — *before* the claimed 7/15. Portland's July `LEAD_INTAKE` rows run
7/19, 7/21×2, 7/22×2, 7/23, 7/24, 7/25, 7/27, 7/28, 7/30 — **nothing between
7/10 and 7/19, and zero errors.** No Swann lead exists anywhere (9 `swan*` rows,
none Katie, none Portland-recent).
**Settled by:** the MAKE scenario history · the form provider's own log · Vercel
logs for 401s in that window. Note the 401 blind spot is [265](#latent).

### 169 — Modal layout defect
**Settled by:** rendering the modal and looking at it.

### 196 — `beta-hiveshell-all-scope` suite
`lib/beta-hiveshell-all-scope.test.tsx` exists.
**Settled by:** an actual `vitest` run on the affected machine.

### 251 — Is the bug sweep "clean"?
**Settled by:** an actual execution of the bug-sweep skill.

### 173 — Blair Moore test
No Blair Moore record exists in `leads`.
**Settled by:** the test definition — what it was meant to assert.

### 137 — ~200 client leads in Zoho
The reachable Zoho `Leads` module is the **FranDev pipeline** ("Quick Connect
Call Booked", "Discovery Call Booked"), not client leads.
**Settled by:** which module or view actually held the ~200 client leads, plus a
join key to diff against `leads`.

---

## Not code

Cross-reference. These items are listed in full elsewhere; they are collected
here because **no amount of code closes them** — each needs a person to decide,
buy, log in, or look.

| # | Listed under | What the person has to do |
|---|---|---|
| 297 | [NEW](#new) | Design the `hub_users` RLS policies **before** anyone runs `ALTER TABLE … ENABLE ROW LEVEL SECURITY`. A blind enable locks the table. |
| 298 | [NEW](#new) | Decide what happens to a real $550 charge sitting on a placeholder `location_id`. Refund, re-point, or reconcile — a money decision, not a patch. |
| 275 | [Latent](#latent) | Buy the paid Supabase custom-domain add-on, set DNS, update the Google redirect URIs. Unfixable from the repo. |
| 288 | [Active](#active) | Make the crew-assignment product decision. Note it has never run — see [300](#300). |
| 286 | [Active](#active) | Set up the scheduled desktop task. Nothing in the repo can create it. |
| 293 | [Unknown](#unknown) | Pull the MAKE scenario history and the form provider's log. Neither is reachable from here. |
| 137 | [Unknown](#unknown) | Open Zoho and identify which module or view held the ~200 client leads. |
| 169 · 196 · 251 · 173 | [Unknown](#unknown) | Render it, run it, execute it, or produce the test definition. |

---

## Decided

**Do not re-open these.** Each was settled with evidence or by an explicit call.
Re-litigating them wastes the audit.

- **257 backfill** — settled. Only the *forward* gap is open, and it is
  [301](#301)-wide (35 onboarding locations). Do not re-argue the backfill.
- **259 payment links** — the design moved to Checkout Sessions on
  `stripe_price_id`. `payment_link_url` is vestigial by intent, not by neglect.
- **241 paused historical clients** — `jobber-import.ts:992` writes `paused: true`
  on purpose so historical clients can't be drip-enrolled. Pinned by a test.
  This is not a bug and not a skip.
- **291 Part 1** — the blanket `assigned_to` null-out is **rejected**: intake
  writes that column deliberately ("first assignee, legacy compat"), so the
  null-out would fight a live writer. The fabricated-data problem stays open;
  the proposed remedy does not.
- **242 SMS filter** — killed. Correct *only* because no SMS step exists and none
  can be created. Recorded as conditional in [Weakest calls](#weakest-calls).
- **243** and **245** — established. 253 replaces 245.
- **268 → 267** and **280 → 276** — combined. Do not re-file as separate tickets.
- **287** — dissolved. Its unique content is salvaged in [Killed](#killed); the
  grab-bag itself is not carried forward.
- **`868kaxm23`** — a dup-closure, **not a fix**. 269 stays open regardless of
  its "done" state in ClickUp.
- **`868kax0tg`** — genuinely resolved, and it does **not** close 276.
- **`868kaxm38`**, **`868kaxm1y`** — done, no open twin.

---

## Weakest calls

Reproduced verbatim from the audit's "Lowest-confidence verdicts". These are the
lines most likely to be wrong. Revisit these first if the world contradicts this
list.

- **260 (KILL)** — symptom-based. Zero occurrences in 18 days is strong, but the
  rotation race in `doRefresh` was not proven gone, only proven quiet. And it
  went quiet at `c7944f4`, the fix the ticket argued was irrelevant — so either
  its root-cause analysis was wrong or something unmeasured changed. First
  verdict to revisit if reauth noise returns.
- **256 (KILL)** — `/api/leads` POST unambiguously enrolls, but only the
  one-line summary of the item was available. If "hand-created" meant a
  different door (hive quick-add, or a path passing `startDrip: false`), this
  answers the wrong question.
- **262 (KILL)** — zero past-due pending rows is a fact, but it is unclear
  whether the backlog was drained deliberately or the close wizards stopped
  writing `pending` at all. Note **553 touchpoints carry `status = NULL`** — a
  consumer scanning "not done" rather than `='pending'` would still find a
  large set.
- **242 (KILL)** — correct only because no SMS step exists and none can be
  created. One seeded SMS step and the filter is a live bug again.
- **227 (KILL)** — rests on the absence of the exact string
  `location.locationId`. A rename would hide the same defect.
- **265 (KEEP)** — arguably over-kept. Both stated asks shipped; held open on
  the 401 residual because it is exactly the Katie Swann shape.
- **292 (KEEP)** — arguably a KILL, since a server-side writer does exist. Kept
  because no UI can reach it, leaving the column permanently NULL.
- **176 / 177 / 179 / 180 / 17 / 54 (KEEP)** — judged from absence of code, not
  from a reproduction. Weaker evidence than the rest of this table.
