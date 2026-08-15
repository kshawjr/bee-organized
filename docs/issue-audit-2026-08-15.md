# Issue list audit — 2026-08-15

**Base:** `origin/main` @ `6edc129` (issue 246 step 3).
**Note:** local `main` was one commit behind at `ddaff79`; `6edc129` was not an
ancestor of the local tip (it existed locally only on branch `worktree-246-step3`).
Audited against `origin/main` content.

**Method:** repo read + live production queries against Supabase project
`pcuycyelxxkxahlxdewl`, plus ClickUp list `901111225249`.
**Read-only:** no ClickUp writes, no Supabase writes, no build, no commit, no push.

**Verdict key:** KILL = not real / already fixed / obsolete · COMBINE = duplicate
of another item · KEEP = still real · UNKNOWN = needs something not available here.

---

## Verdicts

| id | ClickUp | Verdict | Evidence |
|---|---|---|---|
| 247 s3 | — | KEEP | No ClickUp integration in repo (one copy-block comment at `BeeHub.jsx:32307`); planning task, nothing falsifies it. |
| 248 s2 | — | KEEP | `.claude/skills/bug-sweep/SKILL.md` (step 1) exists; no brief cron among `vercel.json`'s six entries. |
| 249 | — | KEEP | `feedback_items_context.sql` shipped (a86b258) but only 3 of 63 items carry context; the two newest (8/12 22:29, 8/13) are NULL — FeedbackModal doesn't send it. |
| 22 | — | KEEP | 246 steps 1–3 shipped the structure (sidebar, New-leads rebuild, orphan toggle); the visual pass is not done. |
| 258 | 868kjfrfh | KEEP | RE-COUNT: not 9 — **5**. 20 active locations; 15 carry `stripe_customer_id`+`stripe_subscription_id`. Missing: Omaha, Portland, Scottsdale, Seattle, Test Location. |
| 259 | 868kjfrc0 | KILL | Webhook live: 36 `stripe_webhook_events`, 16 `billing_invoices`, `sync_log` shows `STRIPE_PAYMENT … subscription_create … $550.00` (Carmel 8/4). Design moved to Checkout Sessions (`app/api/locations/[id]/checkout`) on `stripe_price_id`; `payment_link_url` is vestigial. |
| 260 | 868kjfrwq | KILL | RE-COUNT: **exactly 70, unchanged, zero since 2026-07-28** (18 days) while traffic ran 1,628 landed rows in 7 days. The ticket's claim that `c7944f4` "won't move these numbers" is falsified — failures stop at that 7/30 fix. |
| 261 | 868kew1xa | KILL | All three bugs fixed: `writeLoopShouldYield(wrote, cap, timeLow)` (`jobber-import.ts:418`); auto-continue covers `writing` (`BeeHub.jsx:12607`, `:17317`); sweeper rewritten (`lib/import-continuation.ts`). Prod: 24 completed imports, latest 2026-08-14; every `writing`-phase failure ≤ 2026-07-23. |
| 262 | 868kbduc5 | KILL | RE-COUNT: **zero**. `status='pending' AND occurred_at<=now()` returns 0 rows. All 7 pending touchpoints are Re-engage, dated 2026-10-09 → 2026-11-27. The "review-requested + satisfaction are past-due" premise is wrong — those carry `done`/`sent`/NULL. |
| 263 | 868kjfrwj | KILL | Shipped `640b091`: `app/api/webhooks/resend/route.ts`, Svix-verified, hard bounce/complaint → drip stop gated on `email_kind='drip'`. Live: 21 rows `delivery_status='bounced'` (20 lead_notification, 1 drip), last 2026-08-13. |
| 264 | 868kjfrv7 | KEEP | RE-COUNT: not five — **one**. 9 `not_landed` rows total; only 3 say "engagement unresolved", all the same KC invoice `…MTY1MTkwMTE2` (7/23). The 2 Portland rows carry no unresolved reason. 0 in last 7 days. |
| 265 | 868kjfrrp | KEEP (narrowed) | Both asks shipped — every **authenticated** outcome writes a `sync_log` row, plus unknown-key detection (`KNOWN_INTAKE_KEYS` / `unknown_keys=`). Residual: 401s deliberately unlogged, so a bad-API-key submission is still unanswerable. |
| 266 | 868kawwmh | KILL | `resolveBetaReadOnly` / `isReadOnlyFranchiseRole` in `components/hive/shared/betaGate.js` cite this ticket id; `readOnly` threads through 29 hive files; `HiveShell.jsx:219` implements the mode; `lib/read-only-access.ts` enforces server-side. |
| 252 | 868krpyk4 | KEEP | The two holds named are real and live — `digest_runs` carries `rate_missing` and `booking_link_missing` counters and posted "2 locations on rate-quoting paths with NO RATE (sends held)". No equivalent for the other 12 tags. |
| 253 | 868krpyku | KEEP | `timeline/route.ts:128-131` returns `welcome_email_*` as bare timestamps; the fork/template block (`:89-120`) walks only `scheduled_stage_emails` keys. |
| 254 | — | KEEP | Verbatim in `lib/beta-emails-timing-240.test.tsx`: "Nothing server-side enforces an ordering. The route checks only `Number.isFinite(delay_days) && delay_days >= 0`." Latent — the UI holds the floor. |
| 255 | — | KEEP | `BeeHub.jsx:22076` calls `updateProfile('bookingLink', v)` **before** the fetch; sibling `persistProfileField` documents the opposite policy ("we paint ONLY after the write lands"). |
| 256 | — | KILL | `/api/leads` POST does enroll: `applyDripSideEffects` + inline `sendDripStep` on `stage==='New'` (`route.ts:378-395`); intake `sync_log` rows carry `drip_enrolled=true/false` as the record. |
| 257 | 868kjfrje | KEEP | RE-COUNT: not 31 — **65** manual-source pre-activation leads with no drip and no welcome, across 11 locations, newest Southeast Nashville 2026-08-14. Backfill decision settled; forward gap is live. |
| 267 | 868kawwf0 | KEEP (survivor) | `lib/dual-write.ts:76-80` — `if (payload.stage)`, `if (payload.source)`, `if (payload.jobber_client_id)`, `if (payload.assigned_to)`: falsy skips, clears never reach Zoho. |
| 268 | 868kaxm3d | COMBINE → 267 | Same truthiness guard captured twice; adds nothing 267 lacks. |
| 269 | 868kawwuq | KEEP | The "done" `868kaxm23` is a dup-closure **pointing at this ticket**, explicitly "not resolved". Latent — no demonstrated user-facing path. |
| 270 | 868kbc91q | KILL | `jobber-import.ts:1203-1213` maps `quoteStatus` via shared `mapQuoteStatus`/`quoteStatusStampsApproval`. Prod quotes: approved 4,099 / archived 1,774 / sent 348 / draft 14 / changes_requested 3. |
| 271 | 868kbc91r | KEEP | `jobber-import.ts:1373` still branches on `status === 'PARTIAL'`; prod `invoices` carry only paid 5,956 / sent 49 / bad_debt 7 — zero `partial`. Cosmetic dead code. |
| 272 | 868kaxm3a | KILL | `profile/route.ts:21` — "Was a hard `.range(0, 49)`"; now `REFERRED_US_CAP` with `count:'exact'`, pinned by `lib/beta-reverse-referral.test.tsx`. |
| 273 | 868kaxm39 | KILL | `referred_by_missing` computed and returned by `/api/clients/[id]/profile` (`:205,:241`) and `/api/engagements/[id]` (`:206,:250`); pinned by two tests. |
| 274 | 868kaxm2j | KILL | "Re-sync from Jobber" is live and enabled in Settings → Manage connection (`BeeHub.jsx:17199`), plus "Try again" on error. 24 imports completed, latest 2026-08-14. |
| 275 | 868kbf7g2 | KEEP | Still true — `pcuycyelxxkxahlxdewl` is the live auth host. Unfixable from the repo (paid Supabase add-on + DNS + Google redirect URIs). Cosmetic. |
| 276 | 868kax0tz | KEEP (survivor) | RE-COUNT: not 16 — **50** `no_valid_jobber_token` (last 7/13) + 20 `jobber_reauth_required` (last 7/28). No reconciliation cron among `vercel.json`'s six. |
| 277 | 868kjfrwg | KILL | Fixed by `e8948e3`. `drip-send.ts:325-337` stamps `email_kind:'drip'` + `lead_id` + `lead_name`; `:413` writes the Timeline touchpoint on success. Prod: 143 rows `email_kind='drip'`. |
| 278 | 868kax2x7 | KILL | All three phases live — Phase 3 proven by `digest_runs` (79 rows, `posted:true`, latest 2026-08-05 with rendered Slack payload). |
| 279 | 868kax70g | KILL | `SLACK_WEBHOOK_URL` is set — `digest_runs` rows show `posted: true` and full message text. |
| 280 | 868kax0x2 | COMBINE → 276 | Same reconciliation mechanism; 280 is the one-time proof, 276 the durable cron. Scope is now 20 active locations, not 3. |
| 281 | 868kaxm20 | KEEP (narrowed) | Instrumentation **is shipped** — `logViewAs` at `BeeHub.jsx:35853` with `enter:open-picker` / `enter:confirm` / `exit:restore` + state deltas. Console-only; no captured event, no fix. |
| 282 | 868kjfrwz | KEEP | The ticket says so itself: "Keep this open as the record of the decision, not as a build." |
| 283 | 868kc51yk | KILL | All three pieces shipped — PersonCard retired, `openPerson → openClient` (`HiveShell.jsx:374-381`); "Open this lead in Bee Hub →" button (`lead-notification-email.ts:257-267,377`); `?next=` with open-redirect guard (`lib/auth.ts:10-18`). |
| 284 | 868kaxm2z | KEEP (narrowed) | The 6s undo **is** shipped (`InboxScreen.jsx:659-694`, `6000` on junk + bulk remove). "Confirm-first" is not. |
| 285 | 868kbf90h | KEEP | Assigned To still renders as pills/labels (`BeeHub.jsx:3292`, `:10344`); no pencil-edit pattern. |
| 286 | 868kc4mc3 | KEEP | No scheduled desktop task artifact in repo or `.claude/`. |
| 287 | 868kawx6n | COMBINE → dissolve | 7 of its 9 "older deferred items" are now separate live tickets (289, 269, 284) or verified dead (272, 273, 274 + two ClickUp-done). |
| 288 | 868kbc91t | KEEP | Genuine unmade product decision. Note `job_visits` has 0 rows — the behavior being decided has never run. |
| 289 | 868kaxm2b | KEEP | Prod mixes vocabularies: Nurturing 10,141 / Closed Won 2,623 / New 739 / Final Processing 737 / Estimate Sent 147 / Job in Progress 145 / Request 72 / Attempting 3. |
| 290 | 868kaxm27 | KEEP | `leads.client_status`: 12,364 NULL plus four incompatible vocabularies ('Nurturing' 1,322, 'Client' 843, 'Active' 75, 'no_contact' 2, 'New' 1) while every lens uses `deriveClientStatus`. |
| 291 | 868kdy5fm | KEEP | RE-COUNT: not 2,562 — **14,358**. 17 of 20 locations have exactly one distinct assignee across all leads. **Premise now false:** intake writes `assigned_to` deliberately ("first assignee, legacy compat") — Part 1's blanket null-out would fight a live writer. |
| 292 | — | KEEP (trivial) | A server writer exists (POST `/api/locations/[id]/project-type-senders` accepts `sender_reply_to`) but no UI supplies it — all 5 prod rows NULL; `resend.ts:198` falls back to the location reply-to. |
| 227 | — | KILL | `location.locationId` appears nowhere in the tree; admin roster is built by `lib/seat-roster.ts` (`buildSeatRoster`/`tallySeatStates`). |
| 229 | — | KEEP | No `import 'server-only'` anywhere in `lib/` or `app/` — nothing structurally prevents a server module reaching the client bundle. Latent. |
| 230 | — | KEEP | `<ProcessRemovalsCard />` at `BeeHub.jsx:32929` renders inside `AdminDashboard({..., role, ...})` with no role gate (only "Pricing" is gated), while the route 403s non-super_admin. 226 step 8 removed the quick-action but put the card on the shared dashboard. |
| 231 | — | KEEP | RE-COUNT: **18, not ~24** orphans — AccountEditableRow, AddressRow, AttentionCard, CompanyAddressSection, CompanyEditRow, ContactFieldRow, DripSection, ExpandableAttentionCard, FollowUpReminders, ListEditModal, PartnerEditRow, PlaceholderScreen, ProjectTypeEditModal, QuickNoteInput, SourceInlineField, StatCard, TierEditModal, UpdatePaymentModal — plus `CustomPathBuilder` retained-unmounted by comment. 37,056 lines / 161 components. |
| 234 | — | KEEP | `lib/invite-email.ts:12-17` — owner and corporate invites send as `Kevin Shaw <admin@beeorganized.com>`, called from `/api/seats/buy-and-invite` and `/api/hub_users/invite`, both owner-reachable. |
| 241 | — | KILL | Intentional, not a skip: `jobber-import.ts:992` writes `paused: true` so historical clients can't be drip-enrolled; pinned by `lib/email-send-integrity.test.ts`. |
| 242 | — | KILL | Filter drops nothing: 77/77 `drip_path_steps` are `channel='email'`, 3/3 sms templates `is_active=false`, and the locked accordion was replaced by `TextsComingSoon` (240 step 6, `BeeHub.jsx:23150`). |
| 243 | — | KILL | Established; corroborated by `201407c` and `lib/beta-drip-never-enrolled-243.test.ts`. |
| 245 | — | KILL | Established; 253 is its replacement. |
| 293 | 868kjfrn5 | UNKNOWN | Narrowed: intake `sync_log` logging live since 2026-07-10 (before the claimed 7/15); Portland's July LEAD_INTAKE rows run 7/19, 7/21x2, 7/22x2, 7/23, 7/24, 7/25, 7/27, 7/28, 7/30 — nothing 7/10–7/19, zero errors. No Swann lead anywhere (9 "swan*" rows, none Katie, none Portland-recent). Settled by: MAKE scenario history, form-provider log, Vercel logs for 401s. |
| 169 | — | UNKNOWN | Layout defect; needs the modal rendered. |
| 176 | — | KEEP | `lib/seat-stripe-sync.ts` / `seat-cost.ts` exist with unit tests; 26 seats live. No evidence a real mid-term proration ever executed against Stripe. |
| 177 | — | KEEP | No test-clock harness in `scripts/` or `lib/`. |
| 179 | — | KEEP | `BeeLoader` exists but is wired to the Jobber-connection check screen (`BeeHub.jsx:33011`), not the send-to-Jobber wait. |
| 180 | — | KEEP | No `paid_through` reference in `lib/failure-alerts.ts` or the cron route. Latent — 0 locations past `paid_through_date` (all 2027+). |
| 196 | — | UNKNOWN | `lib/beta-hiveshell-all-scope.test.tsx` exists; needs an actual vitest run on the affected machine. |
| 251 | — | UNKNOWN | Needs an actual bug-sweep skill execution to judge "clean". |
| 173 | — | UNKNOWN | No Blair Moore record in `leads`; needs the test definition. |
| 174 | — | KEEP | `job_visits` has **0 rows** while `engagement_assignees` has 2,553 — the crew-sync target table has never received a row. |
| 17 | — | KEEP | No assignment-rule engine; `assignIncomingLead` resolves owner-by-project-type only. |
| 54 | — | KEEP | No bulk add-to-network path; `/api/leads/[id]/network` is single-lead. |
| 137 | — | UNKNOWN | The reachable Zoho `Leads` module is the **FranDev pipeline** ("Quick Connect Call Booked", "Discovery Call Booked"), not client leads. Settled by: which module/view held the ~200 client leads + a key to diff against `leads`. |

### The four "done" ClickUp overlaps

| ClickUp | Result |
|---|---|
| `868kaxm23` RLS silent-zero | **Not a fix.** Body reads "Closing this one as a dup — not resolved". 269 stays open. |
| `868kax0tg` "Jobs not moving" | Genuinely resolved (user-confirmed, `bc8e310` + backfills). Does not cover 276 — that names itself the separate durable mechanism. |
| `868kaxm38` Snooze badge in Classic | Done; Classic is retired (`lib/beta-classic-retired.test.tsx`). No open twin. |
| `868kaxm1y` Overlay green literals | Done; survives only as a stale line inside 287's grab-bag. |

---

## COMBINE clusters

**A — Zoho null-clear.** Survivor: **267** (`868kawwf0`). Carries the problem
statement, user-impact note, and fix direction. **268** (`868kaxm3d`) is a bare
restatement from another session. One bug: `lib/dual-write.ts:76-80`.

**B — Jobber reconciliation.** Survivor: **276** (`868kax0tz`). Defines the
durable mechanism (a scheduled sweep replaying what a token lapse dropped).
**280** (`868kax0x2`) contributes the acceptance test 276 lacks — a per-location,
per-type Jobber-vs-Bee-Hub count diff — and should become 276's first run.
276 contributes the recurrence a one-time audit has no answer for.

**C — the grab-bag.** **287** (`868kawx6n`) should be dissolved, not carried.
Unique content that would otherwise be lost: the Palm Beach / Portland owner-view
smoke-test to-do; the 21 `$0` Closed-Won data note; the view-as fidelity notes;
and the process note that build-prompt base hashes are unreliable — which
happened again in this audit.

---

## KEEP items, ordered by whether a real person is affected today

### Affecting someone right now

1. **230** — Corporate (Leslie) loads the Admin Dashboard and the Seat Removals
   card fires a 403 every time. Ungated render, super_admin-only route.
2. **255** — A booking link can paint as saved while the write failed.
   `{{owner_booking_link}}` then never resolves and every booking-link send is
   held indefinitely.
3. **252** — Emails going out with holes in them right now, nothing recorded.
   12 of 14 merge tags.
4. **257** — 65 leads across 11 locations never enrolled; newest created
   yesterday, and 35 more locations sit in `onboarding` feeding the same hole.
5. **253** — Owners can now edit welcome copy (240 step 8b) and the timeline has
   never displayed it in any form.
6. **249** — Feedback still arrives without screen/path; the two most recent
   submissions are both NULL.
7. **258** — 4 real locations + 1 test read as paying subscribers Stripe has
   never heard of, while real charges flow for the other 15.
8. **234** — An owner inviting their manager sends mail signed
   "Kevin Shaw <admin@beeorganized.com>".
9. **264** — One KC invoice unattached; that deal's totals and stage are wrong
   on the card.
10. **291** — Fleet-wide assignee data is fabricated; blocks any honest
    "unassigned" signal.

### Latent — real, nobody hit today

265 (401 path) · 267 · 269 · 271 · 275 · 276 · 281 · 284 · 285 · 289 · 290 ·
292 · 229 · 231 · 254 · 174 · 180 · 176 · 177 · 179 · 17 · 54

### Not bugs — process, decision, or record

22 · 247 s3 · 248 s2 · 282 · 286 · 288

---

## Not on the list, and should be

1. **`public.hub_users` has RLS disabled entirely.** Supabase's advisor flags it
   critical: 27 rows of user and role data readable and writable by anyone with
   the anon key. This is the opposite failure from 269 and strictly worse.
   Remediation SQL exists, but enabling RLS without policies would lock the
   table — policies must be designed first, not a blind `ALTER`.
2. **`sync_log.landed_status` is mis-set on non-Jobber events.** 3 of the 9
   `not_landed` rows are successes: a `PROPERTY_UPDATE` that synced fine
   (Seattle 8/5) and two `STRIPE_PAYMENT subscription_create` rows (Carmel 8/4,
   8/1). The 8/5 digest pushed ":warning: 1 Jobber event DIDN'T LAND — Carmel:
   Unknown record — STRIPE_PAYMENT" to Slack — a false alarm. This inflates
   every not-landed count, 264's included.
3. **A location_id literally named `disposable-stripe` took a real $550
   subscription** on 2026-08-01 (`sub_1Tzk7j…`, `paid_through=2027-08-01`).
   Money landed against a placeholder with no `locations` row.
4. **35 locations sit in `lifecycle_status='onboarding'` against 20 active.**
   Item 257's exposure is 35 locations wide going forward, not the "nine" its
   text assumes.
5. **`job_visits` is empty.** The crew-sync target has never received a row
   despite 2,553 `engagement_assignees` — silently invalidating 174, 288, and
   any belief that crew assignment reaches Jobber.
6. **Five tables carry schema and RLS but zero rows:** `payments`, `notes`,
   `location_jobber_users`, `import_staging`, `import_location_fetch`.
7. **The local checkout is behind origin.** Work started from this machine's
   `main` today is missing 246 step 3.

---

## Lowest-confidence verdicts

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
