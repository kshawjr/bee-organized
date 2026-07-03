# HIVE Phase 1 — The Engagement Model

**Status:** LOCKED — design approved 2026-07-03
**Author:** Kevin + Claude (design session)
**Supersedes:** lead-level single-stage pipeline (HIVE Phase 0)

## 1. The problem

The Phase 0 model gives each client exactly one stage. Real clients have many concurrent and historical work cycles (Patricia Anderson: 10 completed jobs, 1 upcoming, 1 new inquiry — one card, one stage, permanent ambiguity). Additionally, Jobber was historically used as a CRM, so imported "requests" include hundreds of interested-but-never-engaged contacts that pollute any request-founded pipeline.

## 2. The model

**Bee Hub owns people. Jobber owns work.**

| Entity | What it is | Has a stage? | Lives where |
|---|---|---|---|
| **Client** (`leads` table, demoted to client record) | The person. Identity, contact info, buzz notes, junk flag, referral, opt-outs, `paused`. | No — has a **status** | Directory + profile |
| **Engagement** (new `engagements` table) | One work cycle (request → quote → job → invoices). | Yes — board **stage** | Board + list |

A client exists in Bee Hub from first contact (webform, manual add, referral). A client only enters Jobber when business is real (assessment scheduled / estimate imminent) via **Send to Jobber**. Every Jobber request founds an engagement. No Jobber record → no engagement → no board card.

### Client status (Bee Hub's own machine — fully decoupled from Jobber)

`New` → `Attempting` → (`Nurturing` ⇄) → `Active client` → `Past client`

- **New** — inquiry arrived (webform/manual/referral), no contact yet
- **Attempting** — being worked (calls/emails), no response or not yet ready
- **Nurturing** — went cold; client-level drip pool. Marketable list.
- **Active client** — has ≥1 open engagement
- **Past client** — all engagements closed, has paid history
- (No email AND no phone AND no activity → `is_junk=true`, off all lists)

### Engagement stage (the board)

`Request` → `Estimate` → `Job in Progress` → `Final Processing` → `Closed Won` / `Closed Lost`

- **Request** means *actively engaging* — assessment scheduled or estimate imminent. NOT "raised a hand" (that's client status New/Attempting).
- **Estimate** is generic — one column for the whole quoting phase. The quote's state (draft / sent / viewed / approved / changes requested) renders as a **chip on the card**, not as columns.
- **Nurturing is NOT an engagement stage.** A stale engagement stays in its column wearing a "nurturing · dNN" chip while the reactivation sequence runs (see lifecycle). Client-status Nurturing is a different thing.
- Closed Won / Closed Lost are terminal and filtered off the active board.
- Engagements table gets ONE authoritative CHECK constraint (Phase 0 had 5 drifting constants + a stale CHECK; do not repeat).
- Engagement stage is strictly monotonic (forward-only). New rank table, engagement-only; do not reuse Phase 0 STAGE_RANK.

## 3. Founding rules (LOCKED)

1. **Every new Jobber request founds a new engagement. Always.** Even if the client has one open.
2. **First engagement for a brand-new client is request-founded** (or manual intake, request-equivalent). Enforced in create UX; **tolerated on import** (historical jobs whose requests predate Jobber — accept, found implicitly, system note).
3. **Repeat clients** (≥1 prior engagement) may found at `quote` or `job` directly.
4. **Attachment via Jobber links (hub-and-spoke around the request):** quote→request (always), job→request (bulk always; webhook nullable), job→quote via `Job.quote { id }` (NEW — add to JOBS_QUERY + SINGLE_JOB_QUERY + nullable `jobs.quote_id`), invoice→job (many invoices per job — weekly billing is first-class).
5. **Unlinked quote/job with no open engagement** → founds one implicitly (`founded_by` recorded, system note). Ambiguous → attach to most-recent-open with logged system note.
6. `founded_by` ∈ {request, quote, job, manual} — drives opening stage: request→Request, quote→Estimate, job→Job in Progress.

## 4. Lifecycle (LOCKED)

- **Quiet clock:** no activity 30 days → nurture condition (stays in column, "nurturing · dNN" chip, `nurture_started_at` stamped) → 60-day reactivation email sequence → no response by ~day 90 → **auto-close Closed Lost**, `closed_reason='lost_no_response'`, system note.
- **Any reactivation** → chip clears, sequence stops, card resumes true stage.
- **Closed Won requires:** job complete AND all invoices settled (balance_owing=0 across engagement). Complete-but-owing → Final Processing. Complete-but-never-invoiced → Final Processing (loose end, correct).
- **Auto-close on import/backfill is silent** — no sequences fire on historical data.

## 5. Historical backfill rules (Jobber-as-CRM era)

- Request-only engagement older than 30 days → close as Lost at backfill (`closed_reason='stale_on_import'`, system note). Client → status **Nurturing** (marketable pool). No board ghost.
- Request-only within 30 days → live engagement in Request.
- Request that led anywhere → founds normally, stage per 447be62 rules re-expressed per engagement.
- Paid + complete → Closed Won (silent). Clients with paid history, no open work → **Past client**.
- No email AND no phone AND no activity → `is_junk=true`.
- **Import summary shows reconciliation math** so owners never read the sparse board as data loss.
- `paused` stays true on imported clients. **Nurture pool UI** (directory banner + Activate drips, pool-level and per-client) is the unpause mechanism.

### Appendix: Dry-run population counts (prod, 2026-07-03)

Read-only counts against production, definitions mirroring `determineLeadStage`
(lib/jobber-import.ts). Baseline: 2,053 leads · 1,418 service_requests ·
994 quotes · 706 jobs · 820 invoices.

| Population | Definition | Count |
|---|---|---|
| Orphan jobs | `jobs.service_request_id IS NULL` | 0 |
| Orphan invoices | `invoices.job_id IS NULL AND service_request_id IS NULL` | 0 |
| Stale-close | only children are SRs, every SR >30 days old (`requested_at`, fallback `created_at`) | 297 — Palm Beach 104, Portland 193 |
| Junk | no email, no phone, zero children | 35 (34 already `is_junk`) |
| Auto-won | ≥1 job all complete (`completed_at` or status ~ "complet"), ≥1 invoice all `paid` | 432 |
| Auto-won edge | all jobs complete but zero invoices (lands Final Processing under rule 3) | 8 |

Parent-linkage backfill fully held: all 706 jobs carry `service_request_id`;
all 820 invoices carry both `job_id` and `service_request_id` (verified by
inverse-filter counts).

**Rollout note (loc_kc):** the KC location has disconnected the Jobber app
entirely (API returns "User has disconnected this app from their account.
Please delete this token"). The stored token is dead and should be deleted;
KC needs a fresh OAuth connect before it is in Phase 1 scope. Counts above
include KC's already-imported rows.

## 6. Drips (LOCKED)

- **Both levels.** Client-level nurture + engagement-level sequences.
- **Collision rule:** active engagement drip suspends client nurture via `lead_drip_progress.paused_at` on client-level enrollment rows, set/cleared from engagement transitions in `applyDripSideEffects`. **Never overload `leads.paused`.**
- Enrollment polymorphic: nullable `engagement_id` on `lead_drip_progress`, unique constraint adjusted (NULLS NOT DISTINCT), cron gains one engagement join, ~15 `.eq('lead_id',...)` sites updated.
- `scheduled_stage_emails` re-keyed by engagement (Phase 0 key collides across engagements).

## 7. Views (LOCKED)

Navigation within the Clients section: **Inbox | Board | List | Clients**

- **Inbox** — front-of-funnel worklist. New inquiries (not in Jobber) + Attempting (last-touch age, snooze). **Send to Jobber** is the only door from people-world to work-world.
- **Board** — one card per engagement. Columns: Request, Estimate, Job in Progress, Final Processing (Won/Lost filtered). Cards: client name, engagement title, value, within-stage chip, repeat badge. Drag moves that engagement.
- **List** — same engagements, flat rows: client · engagement · stage chip · status · value · activity.
- **Clients** (directory) — people with status chips + lifetime value. Nurture-pool banner + Activate-drips flow. Filters: All/New/Attempting/Nurturing/Active/Past/No contact info.
- **Engagement panel** (click card/row) — header (title, stage, founded_by), client strip ("View client →", notes other open engagements), stage bar, RECORDS timeline (request→quote(s)→job→invoice(s), dashed empty invoice slot), engagement-scoped money strip, actions.
- **Client profile** — status chip, lifetime, pause/activate, ALL engagements stacked (open first, closed dimmed).
- Deep links: `/clients/[id]` client-keyed; engagement = `?engagement=` selection state.

### Mobile translation rules (LOCKED)
- Four views → bottom tab bar (within the Clients section; Inbox badge persists).
- Board: one column at a time, swipe + pager dots. Stage moves from the engagement sheet, not drag.
- Rows compress to two lines; filter chips scroll horizontally.
- Engagement panel = bottom sheet with drag handle (existing mobile pattern).
- FAB mobile-only; primary actions (Send to Jobber) full-width.

## 8. Schema

### engagements (new)

```sql
CREATE TABLE engagements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL REFERENCES leads(id),
  location_uuid   uuid NOT NULL,
  stage           text NOT NULL CHECK (stage IN
                    ('Request','Estimate','Job in Progress',
                     'Final Processing','Closed Won','Closed Lost')),
  founded_by      text NOT NULL CHECK (founded_by IN
                    ('request','quote','job','manual')),
  title           text,
  stage_entered_at   timestamptz NOT NULL DEFAULT now(),
  nurture_started_at timestamptz,
  closed_at       timestamptz,
  closed_reason   text,
  closed_note     text,
  total_invoiced  numeric DEFAULT 0,
  total_paid      numeric DEFAULT 0,
  balance_owing   numeric DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

### Children gain nullable engagement_id
`service_requests`, `quotes`, `jobs`, `invoices`, `touchpoints`: `engagement_id uuid REFERENCES engagements(id)` + index. Nullable = non-destructive; backfill separate pass.

### jobs gains quote_id
`quote_id uuid REFERENCES quotes(id)` nullable + `quote { id }` in JOBS_QUERY / SINGLE_JOB_QUERY (optionally SINGLE_INVOICE_QUERY job nodes).

### leads (client record)
Keeps identity/contact/buzz/junk/referral/`paused`/client-drip fields. Gains `client_status` (stored vs derived: build-time call). `leads.stage` FROZEN during migration (dual-write until step 6), then retired. Single-slot `jobber_*_id` denorms move to engagements. `service_requests.stage` + hardcoded `status='active'`: retire. One `leads` row per person per Jobber client (index unchanged — aligns with model).

## 8.5 File structure (LOCKED — strangler split of BeeHub.jsx)

Phase 1 code = modules, never appended to BeeHub.jsx. New surfaces = new files; existing screens extracted when step 4 touches them. components/
ui/            ← app-wide design system (first-class)
StatusChip / Card / Row / FilterChips / MetricCard / Banner / SectionHeader
hive/
InboxScreen, EngagementBoard, EngagementList, EngagementPanel,
ClientDirectory, ClientProfile (extracted)
shared/stageConfig.js  ← ONE stage/status constant source
BeeHub.jsx     (shrinks: shell, nav, legacy)
lib/
engagements.ts (founding, attachment, stage derivation)
client-status.ts Rules: no new code in BeeHub.jsx if it can be a module; every extraction its own commit; mock constants do NOT migrate — extracted components read only mapper output/props.

## 8.6 Design language (app-wide, LOCKED as direction)

Phase 1 look = the app's look. 0.5px hairlines, white cards on quiet surfaces, colored status chips (dark-on-light ramp text), two-line rows, horizontal filter chips, minimal buttons, icon+action banners. Color semantics: teal=new/go, blue=in-motion, amber=attention/nurture, red=money-owed, purple=relationship/repeat, gray=past/closed. Deliverable during step 4: docs/bee-hub-design-language.md.

**Phase 1.5 — visual sweep** (post-Phase 1, zero functional change, per-section commits): 1) Home/dashboard, 2) Contacts/Partners (+rename question), 3) Reports (restyle now, rethink after engagement data), 4) Settings/Admin/Billing. Section redesigns NOT specced now — short design pass each, against the live Clients reference.

## 8.7 Scope fence — what Phase 1 does NOT touch

Home position, Contacts/Partners/Companies, Reports, Settings, Admin, Team/Billing, onboarding, subscription machinery, Guide structure. Phase 1 rebuilds the inside of ONE section (Clients). Touch-ups in passing: dashboard attention cards (re-pointed step 4), Guide slides (post-build).

## 9. Migration sequence (non-destructive, each step ships independently)

0. Dry-run counts (DONE — see §5 appendix).
1. Schema: CREATE engagements + engagement_id columns + jobs.quote_id + indexes. Zero behavior change. Migrations reviewed before running (cast-history rule).
2. Backfill script: group per §5. Idempotent, re-runnable, logs every implicit founding. Portland wipe-and-reimport = test harness.
3. Dual-write: import + webhooks create/attach engagements AND still write leads.stage. Chokepoints: promoteLeadStage / determineLeadStage / applyStagePromotion. Board still reads leads.
4. Read flip, screen-by-screen (~80 sites, 4 clusters): board → list → dashboard cards (stuck=engagement, no-reach-out=client) → location/project views. Inbox + directory built here. Design-language doc written here.
5. Drip layer: polymorphic enrollments, sequences, day-90 auto-close cron, collision suspension, scheduled_stage_emails re-key, nurture-pool UI.
6. Retire: leads.stage writes stop, arbitration deleted, service_requests.stage dropped, Zoho lead-stage dual-write deprecated (zero callers; don't revive).

## 10. Inventory appendix (2026-07-03 sweep)

leads.stage: ~80 reads (BeeHub 10024–10694 board, 20230–20484 dashboard, 25551/29777 views; API/lib), 6 write pathways, 3 chokepoints, 5 duplicated constants + stale CHECK. Linkage: hub-and-spoke on request; bulk always links; webhook job/invoice nullable; Job.quote exists (mirror-confirmed; pinned introspection pending). Drip cron: enrollment-row eligibility only; leads.paused gates enrollment, paused_at gates sends; DRIP_STOP_STAGES already encodes the split. Create flows: manual+intake create bare leads (conformant); founding enforcement at upsertServiceRequest + QUOTE/JOB_CREATE fallbacks; no server-side dedup (Phase 1.5). Breakage: scheduled_stage_emails key (top), single-slot denorms, dashboard cards, touchpoint labels, deep links, child loaders (fetch by lead, regroup client-side), import summary counts. sync_log engagement-compatible.

## 11. Open items / checklist

- [ ] introspect-job.mjs on pinned 2025-04-16 (Job.quote) — token refresh pending
- [x] Step-0 dry-run counts (folded into §5)
- [ ] client_status: stored vs derived (build-time)
- [ ] Contacts rename ("Partners"?) — Phase 1.5
- [ ] docs/bee-hub-design-language.md (step-4 deliverable)
- [ ] Server-side client dedup (Phase 1.5)
- [ ] Batched-import stats undercount (carry-over 7/3)
- [ ] Guide slides refresh (post-build)
- [ ] loc_kc: Jobber app disconnected — delete dead token, needs fresh OAuth connect before Phase 1 scope

## 12. Decision log (all LOCKED 2026-07-03)

1. One card per engagement (related records collapse into one)
2. Every new request always founds a new engagement
3. Drips both levels; engagement suspends client nurture
4. 30d quiet → nurture condition + sequence → auto-close Lost ~day 90; reactivation reverses
5. Build now, launch ON the new model — delay launch if needed
6. Estimate = one generic column; quote state = card chip
7. Vocabulary split: client status ≠ engagement stage; New/Nurturing leave the board
8. Historical stale requests close on import; people → Nurturing pool
9. Repeat-client founding at quote/job; jobs claim engagements via Job.quote
10. Bee Hub owns people, Jobber owns work; Send-to-Jobber is the boundary
11. Views: Inbox | Board | List | Clients (within Clients section); mobile = bottom tabs, single-column board, bottom-sheet panel
12. Strangler file split; primitives in components/ui/; mocks don't migrate
13. Phase 1 look = app-wide design language; Phase 1.5 visual sweep
