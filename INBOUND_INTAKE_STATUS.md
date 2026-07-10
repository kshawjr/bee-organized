# Inbound Lead Intake — Status & Punch-List

Audit date: 2026-07-10 · Audited at main `4fda3b6` · Endpoint: `POST /api/leads/intake`

## What this is

Audit of `POST /api/leads/intake` ([app/api/leads/intake/route.ts](app/api/leads/intake/route.ts)) — the
receiver for inbound leads from Make.com (Make sends form / lead-ad submissions IN, endpoint creates a
lead). Endpoint is much further along than "partial" — core is done; gaps are at the edges.

## Done (don't touch)

- **Auth**: `X-API-Key` header, constant-time compare vs `LEAD_INTAKE_API_KEY`, fail-closed (route.ts:39)
- **Location routing**: `location_slug` in payload → `locations.location_id`; writes both `location_id`
  (slug) + `location_uuid`; unknown slug → 400
- **Lead creation + 3-tier dedupe** (exact-match merges, ambiguous flags `possible_duplicate_of`,
  no-match clean insert), scoped per location, dedupes vs existing clients too
- **Response semantics**: clean 200/400/500 with machine-readable codes; non-fatal downstream failures
  return as `warnings` on 200
- **Downstream**: creation touchpoint always written; drip enrollment + step-1 send, gated on
  `location.lifecycle_status === 'active'` (pre-launch captures lead, skips drip)

## PUNCH-LIST (in priority order)

### Must-fix before real leads flow

1. ~~**OBSERVABILITY (biggest gap)**~~ — **DONE `938c7e2` (2026-07-10)**. Every authenticated outcome
   writes `sync_log` (`direction='inbound'`, `topic=LEAD_INTAKE` in the message so the Webhooks tab /
   Slack digest pick the rows up; 401s deliberately unlogged, mirroring the Jobber signature-invalid
   exception). Error rows carry the error code + the submitted slug/email for diagnosis; success rows
   carry source, dedup tier, drip_enrolled, and any warnings.
2. **[~5min] CONFIRM `LEAD_INTAKE_API_KEY` is set in Vercel Production**. Audit couldn't verify (Vercel
   MCP unauth'd). If it's only in local `.env.local`, the live endpoint 401s everything (safe but dead).
   Check Vercel → Settings → Env Vars → Production. Generate with `openssl rand -hex 32` if absent, put
   same value in Make.
3. ~~**EMAIL-REQUIRED POLICY**~~ — **DONE `938c7e2` (2026-07-10)**. Now `full_name` + (valid email OR
   phone with ≥7 digits); neither → `400 email_or_phone_required`. Phone-only leads are captured but
   NOT drip-enrolled (`drip_skipped_reason: 'no_email'`) — enrolling would burn drip eligibility via a
   `stopped_reason='no_email'` progress row; skipping keeps a later email-bearing resubmission eligible
   (that sequence is test-pinned in `lib/beta-intake-observability.test.ts`).
4. ~~**CONTRACT DOC**~~ — **DONE `938c7e2` (2026-07-10)**: [INTAKE_CONTRACT.md](INTAKE_CONTRACT.md) —
   endpoint, `X-API-Key`, required/optional fields, response semantics, retry guidance (retry 5xx,
   alert-don't-retry 400), and the explicit-`source` requirement for Make.

### Nice-to-have (not blockers)

- Rate limiting (low risk — API key already gates; unauth floods get cheap 401s)
- Per-location API keys (currently one global key)
- Field length caps
- New-lead notification to franchise owner (speed-to-contact for paid leads — currently lead just lands
  in 'New' and waits for hourly rhythm)

## Wiring Make.com (once must-fixes done)

1. Verify/set `LEAD_INTAKE_API_KEY` in Vercel + same value in Make
2. Make HTTP "Make a request" module: `POST https://<prod-domain>/api/leads/intake`, headers `X-API-Key`
   + `Content-Type: application/json`
3. Map body: `location_slug` ← target location's `locations.location_id` (need slug list; each form/ad
   → one slug via Make router or per-location scenario), `full_name`, `email`, `phone`,
   `address`/`city`/`state`/`zip`, `project_type`, `message`, and explicitly set `source`. Optionally
   raw ad/form IDs → `metadata`.
4. Make error handling: 200 = success, retry on 5xx, alert-don't-retry on 400 (400 = mapping bug like
   `location_not_found`, not transient)
5. Smoke-test: pre-launch location first (expect `drip_enrolled: false`, lead + touchpoint land, no drip
   email), then active location for full drip path.

## Time estimate

- Endpoint production-ready (items 1-4): ~2-3h focused
- Make wiring + smoke-test: ~1-2h (wildcard = Make config + location mapping + test loop)
- Total: half-day to full-day; the variable is Make-side config, not Bee Hub code (that's nearly done)

---

# Drip email delivery — audit (base 2d73073)

## What this is

Audit of the drip EMAIL DELIVERY pipeline for new leads (website/Make-inbound AND manually-entered).
Question: once a lead lands and gets enrolled, do drip emails ACTUALLY send — real delivery, correct
from-address, logged, on schedule.

## Headline: the pipeline is REAL and prod-proven (not a stub)

Resend is wired end-to-end; the hourly cron is registered and provably running — a stage email actually
delivered to a real lead 2026-07-09 16:00:13 on the cron tick, from Portland's configured address.
Transport, domain, and cron are NOT the blockers.

## The 3 real blockers

1. **A PATH DRIP HAS NEVER RUN END-TO-END IN PROD.** Exactly one enrollment ever, stopped instantly on
   `no_email`. Steps 2/3 (day-5, day-30) are code-verified only, never fired for real. The multi-step
   sequence is UNPROVEN in production.
2. **ONLY 3 OF 50 LOCATIONS CAN SEND.** Sending is per-location (correct design); only NW Arkansas
   (tara@), Palm Beach (ankur@), Portland (whitney@) have sender config. The other 47 fail closed with
   "missing sender config" until configured.
3. **SENDS AREN'T DURABLY LOGGED + BOUNCES INVISIBLE.** Path-step sends only update a latest-status
   field on the lead (overwritten each step) — no per-send history, can't answer "did lead X get step 2
   at time Y." No Resend bounce/delivery webhook — a bounced email looks identical to a delivered one.
   Same silent-failure class as the webhook work.

## Piece-by-piece

- **Transport**: DONE, prod-proven (lib/resend.ts, real `emails.send()`, delivered yesterday). Local
  `.env.local` key is empty so couldn't enumerate Resend domains — verification inferred, not inspected.
- **From-address**: DONE in code (per-location `send_from_email`/`sender_name`/`reply_to`, fails closed
  if unset), PARTIAL in data (3/50 configured, all @beeorganized.com). Portland's successful send
  strongly implies beeorganized.com is verified in Resend — confirm in dashboard.
- **Schedule**: DONE in code, cron proven running hourly (`/api/cron/send-drips`). Step 1 inline at
  create; next steps scheduled 9am location-local (the "Central Time (CT)" tz values are fine — alias
  table maps to IANA). Steps 2+ never prod-fired.
- **Logging**: PARTIAL (weakest link). Latest-status-only on lead row; welcome + stage emails write
  `kind='drip'` touchpoints but regular path steps DON'T; timeline synthesizes past steps with estimated
  dates. Cron response persisted nowhere, alerts no one (Slack unset). No bounce webhook.
- **Content/templates**: DONE. 8 master paths (organizing/moving × A-D), 3 steps each, real
  subjects/bodies (0 null in prod), welcome + 6 stage masters. `{{variable}}` merge with sane fallbacks
  (missing → empty string, never raw `{{...}}`). Per-location clone supported, none cloned yet (all use
  corp masters).
- **Manual vs inbound**: BOTH wired, same machinery (`applyDripSideEffects` + inline step-1). Intake
  also enrolls on dedup-match if never enrolled. Jobber imports land `paused=true`, require per-lead
  "Activate Drips" opt-in (why 50 paused imports + 0 active drips today).
- **Gating**: intake gates on `lifecycle_status === 'active'` (explicit). Manual path has NO explicit
  lifecycle gate — only de-facto gated by `default_drip_path=null` skipping silently. Outcomes match
  today but would DIVERGE if an onboarding location gets a drip path set. Align.

## Punch-list to go-live (priority order)

1. **[DO FIRST — cheap, high-value] END-TO-END SMOKE TEST a path drip**: unpaused test lead +
   controlled inbox at an active location; verify step 1 in seconds, welcome ~24h, step 2 day-5 9am
   local. The one thing never done for real — proves the multi-step engine before investing in
   47-location config.
2. **PER-SEND RECORD for path steps**: write a `kind='drip'` touchpoint (or `drip_sends` row) per step
   send + store Resend message id. Mirrors welcome/stage. Without it, 50 locations of drips are
   unauditable.
3. **RESEND BOUNCE/DELIVERY WEBHOOK + cron-run persistence/alerting**: bounces invisible today; cron
   failures evaporate. Pairs with the webhook-observability work (Slack still unset).
4. **LOCATION GO-LIVE CHECKLIST enforced at activation**: require `send_from_email`, `sender_name`,
   `reply_to_email`, `default_drip_path`, `timezone` before `lifecycle_status` flips active. Nothing
   validates this today.
5. **CONFIRM DOMAIN VERIFICATION in Resend dashboard** + decide sender-domain policy for the next 47
   locations (shared @beeorganized.com vs per-location domains, each needing SPF/DKIM).
6. **ALIGN MANUAL-LEAD GATE** with intake's explicit `lifecycle_status` check (or document the silent
   skip).
7. **DECIDE PAUSED-IMPORTS POLICY** — 50 drip-eligible leads at active locations sitting paused awaiting
   per-lead "Activate Drips."

## Combined lead-lifecycle status (intake + drip)

- **Lead LANDS**: intake endpoint solid (auth, routing, dedupe done); gaps = observability, Vercel key
  check, email-or-phone policy, contract doc.
- **Lead NURTURED**: drip engine real + prod-proven for 3 locations; gaps = never smoke-tested
  end-to-end, 47 locations unconfigured, sends not durably logged, bounces invisible.
- **The through-line gap on BOTH**: silent failures aren't visible (intake failures not logged; drip
  bounces invisible) — the same problem the webhook-observability feature solves for Jobber, now needed
  for intake + email too.
