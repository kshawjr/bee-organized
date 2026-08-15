# Issue 240 — Communication rebuild: the plan

**Base:** `f4f695b` (verified as `origin/main` tip). Worktree `.claude/worktrees/issue-240`, branch `claude/comms-rebuild-240`.
**Status:** PLAN ONLY. No code written.
**Prod reads:** aggregate, read-only, 2026-08-15.

Line citations are `components/BeeHub.jsx` unless a path is given.

---

## 0. The headline

Three findings reorder the work:

1. **The four-versus-nine problem is already solved in data.** `lookups` (category `project_types`) holds 16 rows of which **exactly 4 are active** — and they are precisely the mockup's four, already carrying the right `drip_category`. Screen 2's rows come free. The "nine" is a dead hardcoded array.
2. **Screen 2 is mostly re-presentation.** `ProjectTypeSenders` ("Emails come from") and `NewLeadNotifications` ("Lead goes to") both exist, with routes, and both already read that same 4-row active list. The separation the mockup asks for is already real in the schema — two independent flags.
3. **Screen 1's six rows span three different rails**, and only three of them are drip steps. Two of the six have their timing hardcoded as a **code constant**, so the mockup's pencil icon on "3 months later" is not a control — it's a schema build.

And one thing that is scarier than anything in the mockup: `PATCH /api/drip-paths/[id]/steps` has **no `is_master` guard** and hard-deletes the entire step set before re-inserting. See §7.

---

## 1. The route map

### Screen 1 — Emails

| Mockup element | Route today | File |
|---|---|---|
| Row 1 "Right away" (`s1`) | GET `/api/locations/:id/drip-paths` | `app/api/locations/[id]/drip-paths/route.ts` |
| Row 2 "Next day" (welcome) | **no route** — `leads.welcome_email_scheduled_at`, cron-only | `lib/welcome-email.ts:23` |
| Rows 3–4 (`day 5`, `day 30`) | GET `/api/locations/:id/drip-paths` | same as row 1 |
| Rows 5–6 "After a job is finished" | **no owner route** — `scheduled_stage_emails`, seeded from code constants | `lib/stage-emails.ts:40-43` |
| Read (modal body/subject) | already in the drip-paths GET payload; masters via GET `/api/drip-paths/masters` | `app/api/drip-paths/masters/route.ts` |
| Edit (subject + body) | PATCH `/api/drip-paths/:id/steps` (bulk replace, the only owner write seam) | `app/api/drip-paths/[id]/steps/route.ts` |
| The fork behind Edit | POST `/api/locations/:id/drip-paths/clone` | `app/api/locations/[id]/drip-paths/clone/route.ts` |
| "Put the Bee Organized wording back" | DELETE `/api/locations/:id/drip-paths/:pathId` (409s if any lead is mid-drip) | `app/api/locations/[id]/drip-paths/[pathId]/route.ts:64-77` |
| Edit on **welcome** or a **closed-job** row | POST `/api/templates/:id/duplicate`, then PATCH `/api/templates/:id` | `app/api/templates/[id]/duplicate/route.ts` |
| "Use a different one" → *Bee Organized wrote these* | GET `/api/drip-paths/masters` + GET `/api/templates` (masters = `location_uuid IS NULL`) | — |
| "Use a different one" → *You wrote these* | GET `/api/templates` (forks = `location_uuid` set) | `app/api/templates/route.ts` |
| "Write one from scratch" | POST `/api/templates` | `app/api/templates/route.ts` |
| Timing ✎ on rows 3–4 | PATCH `/api/drip-paths/:id/steps` (`delay_days`) | as above |
| Timing ✎ on rows 5–6 | **DOES NOT EXIST** — see §3 | — |
| The two questions | PATCH `/api/locations/:id/drip-paths` `{default, default_move}` | `app/api/locations/[id]/drip-paths/route.ts:206-219` |
| …collecting the booking link inline | PATCH `/api/locations/:id` → `calendar_link` | `app/api/locations/[id]/route.ts` |
| …collecting the rate inline | PATCH `/api/locations/:id` → `rate_per_hour` | same |
| Paused banner / dimmed rows | **no route** — derive client-side from rate/link + whether the body quotes the tag | guards: `lib/rate-guard.ts:15`, `lib/booking-link.ts:106` |
| "Who these come from" card | GET `/api/locations/:id/project-type-senders` | `app/api/locations/[id]/project-type-senders/route.ts` |
| "＋ Add another email" | PATCH `/api/drip-paths/:id/steps` (append) | as above |

### Screen 2 — Your team

| Mockup element | Route today | File |
|---|---|---|
| The four rows themselves | GET `/api/locations/:id/project-type-senders` → `project_types` (reads `lookups` where `is_active`) | `lib/project-type-senders.ts:94-99` |
| Parent grouping Organizing / Moving | `lookups.attrs.drip_category` — in the same payload | — |
| "Emails come from" | POST / DELETE `/api/locations/:id/project-type-senders`; PATCH `{enabled}` for the master flag | `app/api/locations/[id]/project-type-senders/route.ts` |
| "Lead goes to" | PATCH `/api/locations/:id/notification-recipients` `{hub_user_id, category}` | `app/api/locations/[id]/notification-recipients/route.ts` |
| …master flag | PATCH same route `{split_enabled}` | same |
| "Tell them by email" | the same `category` / `subscribed` fields | same |
| "Tell them in Slack" | **NO PER-TYPE MODEL** — one channel per location | `lib/slack-bot.ts:356-372` |
| People in the dropdowns | `people[]` in the project-type-senders GET (live `hub_users`, owner/manager) | `app/api/locations/[id]/project-type-senders/route.ts` |

### Screen 3 — Texts & scripts

| Mockup element | Route today | File |
|---|---|---|
| Texts (dimmed, "Coming soon") | **nothing to wire** — static copy | — |
| Call scripts, read | GET `/api/templates`, filter `type='call'` | `app/api/templates/route.ts` |
| Call scripts, edit | PATCH `/api/templates/:id` | `app/api/templates/[id]/route.ts` |
| "＋ Add a script" | POST `/api/templates` `{type:'call'}` | `app/api/templates/route.ts` |

Storage for both already exists — `templates.type CHECK IN ('email','sms','call')`, `migrations/drips_infrastructure.sql:83`. Nothing sends either: `lib/drip-send.ts:154-157` skips non-email channels, and the only occurrence of "Twilio" in the repo is placeholder copy at `:22409`.

---

## 2. The four-versus-nine problem

### What is actually in production

`lookups`, `category='project_types'` — 16 rows, **4 active**:

| label | `drip_category` | active |
|---|---|---|
| Home or Office Organizing | `general` | ✅ |
| Concierge Services | `general` | ✅ |
| Other | `general` | ✅ |
| Moving/Relocation | `move` | ✅ |
| Kitchen + Pantry, Closet + Office, Garage, Full Home, Bedroom + Closet, Basement, Attic, Master Closet, Pantry, Mudroom + Entry | `general` | ❌ |
| Move-In Organization, Move-Out Organization | `move` | ❌ |

The twelve were deactivated on 2026-07-16. **The active four are exactly the mockup's four, with exactly the mockup's parent grouping.**

### Where "nine" comes from

Not from the live picker. `HeaderChips.PROJECTS` at `:3762` is a nine-item array that writes local demo state only. The array that does back the in-app New Lead / New Job selects is `PROJECT_TYPES` at `:33204` — **thirteen** items — used as the fallback when the `lookups` fetch hasn't landed (`getProjectTypes()` `:1275-1279`).

### `leads.project_type` in production — 14,372 leads

| value | count | last 90d | locations | in active lookups |
|---|---|---|---|---|
| *(null)* | 13,869 | 895 | 20 | — |
| Home or Office Organizing | 302 | 294 | 45 | ✅ |
| Moving/Relocation | 93 | 92 | 32 | ✅ |
| **Client** | **53** | **53** | **13** | ❌ not in lookups at all |
| Other | 29 | 29 | 23 | ✅ |
| Concierge Services | 11 | 10 | 9 | ✅ |
| Move-In Organization | 4 | 4 | 1 | ⚠️ inactive row |
| Garage | 4 | 4 | 3 | ⚠️ inactive row |
| Kitchen + Pantry | 2 | 2 | 1 | ⚠️ inactive row |
| Full Home | 2 | 2 | 1 | ⚠️ inactive row |
| **organizing** | 2 | 2 | 1 | ❌ lowercase legacy |
| Move-Out Organization | 1 | 1 | 1 | ⚠️ inactive row |

Of the 503 non-null leads, **435 (86.5%) are exactly the four**.

**"Home Staging" does not exist in production.** Not in `leads.project_type`, not in `lookups`. If you saw it, it came from somewhere else — worth pinning down before it shapes a decision.

### What happens to the strays

Three different resolvers, three different answers — this is the real finding:

- **`resolveDripCategory`** (`lib/stage-emails.ts:116-127`) — exact label, **`is_active = true` only**. So `Client`, `organizing`, and all 13 leads on now-inactive rows fall to `'general'`. **The 5 Move-In / Move-Out Organization leads therefore run the ORGANIZING drip, not the moving one.** Small live bug, pre-existing.
- **`canonicalProjectType`** (`lib/lead-assignment.ts:117-137`) — matches active **and inactive**, plus two aliases (`moving`, `organizing`). So `organizing` resolves; `Client` → `null` → location owner, flagged `projectTypeUnrecognized`.
- **`resolveProjectTypeSenderOverride`** (`lib/resend.ts:224-247`) — **raw string, no canonicalization**. So lowercase `organizing` routes assignment correctly but silently misses its sender override.

### Verdict

**Screen 2 is buildable as drawn.** Its rows come from `lookups where is_active`, which is what both backing libraries already read. No migration, no backfill, no vocabulary decision required. Leads carrying other values are untouched by Screen 2 — they fall through documented defaults (owner for assignment, base sender for from-address, `general` for drips).

Two caveats to carry into the build:
- The Organizing/Moving grouping is `attrs.drip_category`, which is **admin-owned** (Configure tab). Screen 2 should display it, not let an owner edit it.
- The in-app New Lead picker still offers thirteen values that Screen 2 will have no row for. Separate cleanup, separate issue.

---

## 3. Timing

**Storage:** `drip_path_steps.delay_days`, `int NOT NULL DEFAULT 0`, units **days** (`migrations/hive_clients_phase0.sql:212`). Semantics are **absolute-from-drip-start**, not step-to-step; the gap to the next send is a diff (`lib/drip-send.ts:585-595`). Sends fire at 9am location time.

**Can it be changed per location today? Yes — and it forks exactly like the copy does.** `EditableDelay` (`:3877-3925`, rendered `:21926`) → `commitDelayChange` (`:20960`) → `ensureOwnedThen` → `commitSteps` (`:20808`) → one bulk PATCH. `saveStepContent` (`:20938`) takes the identical path. There is no delay-only route and no separate fork gate.

**Are steps shared rows? Yes — that's why the fork exists.** The 8 masters (`organizing-a..d`, `moving-a..d`) are single row-sets with `location_uuid IS NULL`. Onboarding clones **nothing** — it only writes two text path keys onto `locations`. Enrollment reads the master directly when no copy exists (`lib/drip-lifecycle.ts:129-159`). Production today: **8 masters, 17 location-owned copies, 77 step rows across 25 paths.**

### But the mockup's six rows are three different rails

| Mockup rows | Rail | Timing storage | Editable per location? |
|---|---|---|---|
| Right away / Day 5 / Day 30 | `drip_path_steps` | `delay_days` column | **Yes**, via fork — already works |
| Next day (welcome) | `leads.welcome_email_scheduled_at` | `WELCOME_DELAY_MS = 24h`, **code constant** (`lib/welcome-email.ts:23`) | No — and the mockup correctly marks it fixed ✅ |
| 3 months later / A year later | `scheduled_stage_emails` | `CLOSED_WON_TRIGGERS = [90, 365]`, **code constant** (`lib/stage-emails.ts:40-43`) | **No — and the mockup marks these editable ✎** |

**That last row is the single biggest hidden build in Screen 1.** Making it real needs: a per-location delay store, resolution inside `scheduleStageEmails`, and a decision about the **220 closed-job rows already scheduled** (110 × 2, across 17 locations, none sent yet) which carry the old `send_at` and would not move.

Recommendation: ship those two rows with timing **displayed but not editable** in the first pass, and treat per-location stage-email timing as its own issue.

Also note the drip path step count is **not fixed at three** — masters have 3 steps, but forks have been edited and 77 step rows sit across 25 paths. The mockup's "4 emails over a month" header must be computed, not hardcoded.

---

## 4. Combined mode

**There is no combined state today.** `locations.default_drip_path` and `locations.default_move_drip_path` are both `text` path keys (nullable since `migrations/cleanup_legacy_drip_paths.sql:96-111`). **All 20 active locations have both set.** Selection is `lib/drip-lifecycle.ts:113-120`:

```js
const dripCategory = await resolveDripCategory(leadRow?.project_type ?? null)
const pathKey = dripCategory === 'move'
  ? loc.default_move_drip_path || loc.default_drip_path
  : loc.default_drip_path
```

### What "combined" should mean at the data level

**`default_move_drip_path IS NULL`.** The read path already supports it — that `||` fallback is exactly the combined behaviour, shipped and live. No new column, no send-path change, no migration.

- **Split** = write a moving key into `default_move_drip_path` (and clone the moving master if the owner then edits it).
- **Rejoin** = null it out.

**One correction to the mockup.** The fallback always resolves to the *organizing* column, so a plain null-out silently means "keep the organizing wording" — which contradicts the rejoin dialog's "Keep the moving wording" option. Rejoining while keeping the moving wording must **write the kept path key into `default_drip_path`** and then null the move column. Path keys are free text and the lookup is by key, so `default_drip_path = 'moving-b'` is legal and works; the rate/booking health heuristics key on the trailing letter (`-a|-b`, `-b|-d`), so they still classify correctly.

### What rejoining does to the set not kept

**Nothing destructive, and nothing to in-flight leads.** Two facts make this safe:

- `lead_drip_progress` references `drip_path_id` **directly**, and `drip-lifecycle` reads the defaults **only at enrolment**. So the 145 live progress rows keep running whatever path they started on. Rejoining never yanks a lead mid-sequence.
- The dropped family's location-owned fork should be **left in place**, not deleted. `DELETE /api/locations/:id/drip-paths/:pathId` already 409s while any lead is mid-drip (`:64-77`), so deletion would fail half the time anyway. Leaving the row means re-splitting later restores the owner's edits instead of resetting them to master.

So: rejoin is a one-column write plus (when keeping moving) a second. The unkept set becomes dormant, recoverable, and harmless.

---

## 5. What dies

### Tabs

| Key | Label | Lines | Fate |
|---|---|---|---|
| `paths` | Communication | `:21712-22019` | replaced by **Emails** + **Your team** |
| `templates` | Templates | `:22021-22197` | replaced by **Emails** (library) + **Texts & scripts** |
| `automation` | Automation | `:22199-22254` | **deleted outright** |
| `notifs` | Alerts | `:22256-22414` | **deleted outright** |

The `sections` array at `:21273-21286` and the short-label map at `:21317-21318` change with them.

### Components

- Tier-1 "Sending identity" hero `:21735-21775` — badge dies; the three sender fields move.
- `PathTwoQuestionSelector` `:14103-14147` — replaced by the one-sentence + Change. Today it is asked **twice** in Settings (once per sequence tile) and twice more in onboarding.
- The four `PATH_STYLES` radio rows `:21846-21988` — these *are* the two questions; they fold into the sentence.
- `COMMS_TEMPLATE_TILES` `:20095-20099` + `CommsTemplatesModal` `:20184` — die.
- Templates tab's three collapsibles + Master/Custom split + the **Duplicate** action `:22089` — die. Duplicate becomes Edit; the fork stays as plumbing.
- `AlertRow` `:18871`, `AutomationStep` `:19787` — die with their tabs.
- `SmsAddonCard` `:18556` — **already dead**: defined, never mounted. Delete while we're here.

### Routes

**Almost none die.** This is a presentation rebuild: the drip-path, template, clone, sender and recipient routes all survive and are reused. That is the good news, and it is why the work decomposes cleanly.

### The three things that lie

**a) "Verified sender" — verifies nothing.**
`const verified = !!settings.location.sendFromEmail` (`:21723`), rendered as a green check pill at `:21741-21746`. Any non-empty string flips it. There is no Resend identity call, no `verified` column, no verification job anywhere in `lib/` or `app/api`. **All 20 active locations display "Verified sender" today** purely because they have a non-empty `send_from_email`. The field's own hint even admits verification happens out of band. Kill the badge; real verification is a separate issue.

**b) The Alerts tab — persists nothing.**
`:22256-22414` renders five client-alert rows with Email/SMS/Push chips, an assessment-reminder minutes select, a stuck-client days select, Partner Referral / Weekly Digest / Monthly Report, quiet-hours enable + from/to, and an SMS block containing a **"Verify" button with no `onClick` at all** (`:22405`). Every control calls `updateNotif` (`:20518`), which is `setSettings` and nothing else. State seeds from `DEFAULT_SETTINGS.notifications` on every mount, is never fetched and never posted. No table, no route. **Reload reverts every toggle.**

**c) The Automation tab — a static explainer describing emails that do not exist.**
`:22199-22254`, a literal array through `AutomationStep`. No state, no fetch, no route. What it claims, checked:

| Claim | Reality |
|---|---|
| "New lead emails start within 24 hours automatically" | ✅ true |
| "Welcome Email auto-fires 24h after Email 1" (Templates tab, `:22164`) | ✅ true |
| "Light-touch emails every 3–4 weeks keep you top of mind" (Nurturing) | ❌ **no nurture drip exists** |
| "90 days → auto-closes as Lost. System sends a final 'closing your file' email first" | ❌ **no auto-close job, no closing email** |
| "Assessment booked in Jobber → Confirmation email sends" | ❌ **no assessment confirmation email** |
| "Invoice paid → Closed Won. Review request email sends automatically" | ⚠️ **misleading** — the review ask lives inside `opp_closed_job_3mo`, which sends **90 days later**, not on payment |

---

## 6. The estimate emails

### Production today — `scheduled_stage_emails`, 468 rows

| key | total | sent | cancelled | **pending** | locations |
|---|---|---|---|---|---|
| `opp_organizing_estimate_3d` | 115 | **59** | 37 | **19** | 16 |
| `opp_organizing_estimate_30d` | 115 | 5 | 56 | **54** | 16 |
| `opp_moving_estimate_3d` | 8 | 3 | 3 | **2** | 5 |
| `opp_moving_estimate_30d` | 8 | 0 | 3 | **5** | 5 |
| **estimate total** | **246** | **67** | 99 | **80** | 14 |
| `opp_closed_job_3mo` | 111 | 0 | 1 | 110 | 17 |
| `opp_closed_job_12mo` | 111 | 0 | 1 | 110 | 17 |

Your **59** is exactly `opp_organizing_estimate_3d` sent. Your **~115** is the row *total* for one key — **the number that will actually fire is 80**, none overdue, spread over 14 locations (loc_kc 22, nwarkansas 8, lakenorman 7, portland 6, seattle 6, northjersey 6, bostonsuburbs 5, palmbeach 5, carmel 4, omaha 3, scottsdale 2, temecula 2, northpittsburgh 2, siouxfalls 2).

### Action 1 — stop future sends (code)

In `lib/stage-emails.ts:160-162`, the `newStage === 'Estimate Sent'` branch selects `ESTIMATE_ORGANIZING_TRIGGERS` / `ESTIMATE_MOVING_TRIGGERS`. Make that branch `return` like any other non-triggering stage.

- **Keep the four keys in `ALL_STAGE_EMAIL_KEYS`** so cancellation scoping still covers legacy rows.
- **Keep the four master `templates` rows.** They are referenced by the 67 sent rows' history and by `notification_log` / `touchpoints` labels. Deleting them would turn pending rows into errors rather than skips.
- Existing tests assert Estimate-Sent scheduling; they change in the same commit.

### Action 2 — cancel the 80 already scheduled (data)

`cancelStageEmails()` (`lib/stage-emails.ts:196-217`) is **per-lead and cancels every key** — it cannot be used here, because it would also kill closed-job rows for those leads.

Recommended: a one-off dry-run-first script setting `cancelled_at = now()` and `cancelled_reason = 'estimate_emails_retired'` where `stage_email_key IN (<4 keys>) AND sent_at IS NULL AND cancelled_at IS NULL`. `cancelled_reason` is free text, no CHECK (existing values in prod: `stage_changed` 100, `no_email` 1). This matches the `scripts/` precedent and is reviewable before execution.

Alternative: add an optional `keys?: string[]` filter to `cancelStageEmails` and drive it from a super_admin route. More code, more surface, same outcome.

### Both are required

Action 1 alone leaves 80 emails firing over the next ~30 days. Action 2 alone means the next `Estimate Sent` transition re-queues them. **Doing only one leaves half of them firing** — exactly as you said.

### While we're in here

The **220 pending closed-job rows** survive deliberately — they are the mockup's "After a job is finished" group. But if per-location timing for those two ever ships (§3), those 220 rows carry the old `send_at` and will not move. Decide then: leave in-flight, or re-stamp.

---

## 7. The order of work

Eleven steps, each safe alone, in the shape that worked for 226.

| # | Step | Risk |
|---|---|---|
| **1** | **Kill the three liars.** Delete the Alerts tab, the Automation tab, the Verified-sender badge, and the orphaned `SmsAddonCard`. Pure deletion — no data, no routes. | none |
| **2** | **Fix `PATCH /api/drip-paths/[id]/steps`.** Add the `is_master` guard. Must land before anything touches editing. | low, high value |
| **3** | **Stop the estimate emails** (code) — then **cancel the 80** (script, dry-run reviewed before `--execute`). Two commits. | ⚠️ **prod write** |
| **4** | **Tab shell.** Add Emails / Your team / Texts & scripts alongside the existing tabs. Nothing moves yet. | none |
| **5** | **Screen 2 — Your team.** Re-present `ProjectTypeSenders` + `NewLeadNotifications` over the 4 active lookups rows. Existing components, existing routes. | low |
| **6** | **Screen 3 — Texts & scripts.** Texts = static dimmed copy. Call scripts = read/edit over `templates` where `type='call'`. | none |
| **7** | **Screen 1, read-only.** The unified six-row list with when / subject / first line / Read. This is where the three-rails merge gets proven. | medium |
| **8** | **Screen 1, Edit.** Fork-as-plumbing, "Your wording" + reset, "Use a different one" library. | ⚠️ **see below** |
| **9** | **The two questions as one sentence**, collecting rate / booking link inline, plus the paused banner and dimmed rows. | low |
| **10** | **Timing controls** on the three drip-step rows. Closed-job timing display-only unless its schema build is in scope. | medium |
| **11** | **Combined mode** (split / rejoin) — last, because it is the only genuinely new data concept. Then retire the old two tabs. | medium |

### The risky moments, named

- **Step 3's prod write.** 80 rows. Dry-run output goes to you before `--execute`.
- **Step 8's first-ever welcome / stage fork.** Production has **11 template forks and 17 path forks** today (Seattle and KC) — but **zero** of them are `welcome` or `opp_*`. The fork-resolution code for those shipped in #206 and has **never been exercised against a real fork**. The first one is the test.
- **`PATCH /api/drip-paths/[id]/steps` today.** No `is_master` check — it selects only `id, location_uuid` (`app/api/drip-paths/[id]/steps/route.ts:41-53`) — and it **hard-DELETEs the whole step set then re-inserts** (`:105-140`). An owner is blocked incidentally, but an **admin** PATCHing a master path id would wipe the shared master's steps for all 20 locations. This is why it is step 2, not step 8.

---

## 8. What I would push back on

**1. The pencil on "3 months later" and "A year later" isn't a control — it's a schema build.** `CLOSED_WON_TRIGGERS` is a code constant. Ship those two rows with timing shown but not editable, or accept a storage + resolution + 220-row-migration project. *(§3)*

**2. "Lead goes to" as a single dropdown loses information.** The model is many-to-many: each recipient claims a *set* of types, several people can claim one type, and **50 external recipients** exist in prod who aren't hub_users at all. One dropdown per row can't say "Carol and Alex both" or "notify carol@ who has no login". Make it multi-select, or add a "more people" link to the full recipient list.

**3. The per-row Slack checkbox has no backing model.** Slack is **one channel per location** (`locations.slack_channel_id`); `project_type` only tints the message colour (`lib/slack-bot.ts:340`). Recommend one Slack control for the whole screen — "Post new leads to #channel" — not a checkbox per job type. 15 of 20 active locations are connected.

**4. "Emails come from" only affects the new-lead drip.** `senderProjectType` is passed **only** by `lib/drip-send.ts:325`. Stage emails (`lib/stage-emails.ts:463`) and the welcome email (`lib/welcome-email.ts:322`) always use the base location sender. So Screen 1's "Who these come from" card would be **wrong for three of its six rows**. Either pass `senderProjectType` on those two rails too (small, and I'd recommend it), or the card must say "new-lead emails only".

**5. The Read modal's "From … depending on the job type" has the same problem** — and `split_senders_enabled` is on at only **2 of 20** active locations. For the other 18 the honest answer is one name, not a list.

**6. Rejoin "keep the moving wording" doesn't survive a plain null-out.** The read path falls back move→organizing, so combined always renders the organizing column. Rejoin must write the kept key into `default_drip_path`. *(§4)*

**7. "Zero locations have ever customised a welcome or stage email" is true but narrower than it reads.** Prod has **11 template forks and 17 path forks** — Seattle and KC found Duplicate and used it heavily for drip steps. The gap is specifically `welcome` and `opp_*`. Worth narrowing the claim so the design doesn't over-rotate on "nobody can find the fork".

**8. "Home Staging" is not in production.** 14,372 leads, no such value; not in `lookups` either. The real strays are `Client` (53, all recent, 13 locations) and lowercase `organizing` (2), plus 13 leads sitting on now-inactive lookups rows. Worth pinning down where you saw it before it shapes a decision.

**9. The four-versus-nine problem is mostly already solved** — but the *in-app* New Lead / New Job pickers still offer **thirteen** values (`:33204`) that Screen 2 will have no row for. Screen 2 is safe; that picker is a separate cleanup and deserves its own issue.

**10. The paused state is real but currently affects exactly one location.** By path-letter heuristic (`-a|-b` quote the rate, `-b|-d` quote a booking link) the only active location currently held is **loc_carmel** (organizing-a / moving-a, no rate). Rate is set at 9 of 20 active locations, `calendar_link` at 6 of 20 — but the locations missing them are mostly on `-c` paths, which quote neither. Worth building the banner honestly rather than for a crowd that isn't there.

**11. "4 emails over a month" must be computed.** Masters have 3 steps; forks have been edited (77 step rows across 25 paths). Some locations have more.

### One thing the mockup gets exactly right

The two settings on Screen 2 genuinely **are** separate in the schema — `split_senders_enabled` and `split_notifications_enabled` are independent booleans, deliberately so (`migrations/split_notifications_enabled.sql:11-15`). And all four merge tags the mockup uses (`first_name`, `owner_name`, `location_name`, `phone`, `reviews_link`) are real members of the 14-key context. Nothing to fix there.
