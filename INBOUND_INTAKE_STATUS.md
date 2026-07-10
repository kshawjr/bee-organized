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

1. **[~1-2h] OBSERVABILITY (biggest gap)**: endpoint writes NOTHING to `sync_log` — a failed Make lead
   dies in Vercel logs, invisible in Bee Hub. Add a `sync_log` write (success + failure) mirroring the
   Jobber receiver (`direction='inbound'`). When the webhook-observability dashboard work lands
   (currently unmerged — the Webhooks tab / Slack digest are NOT on main at `4fda3b6`), feed this
   endpoint into it too.
2. **[~5min] CONFIRM `LEAD_INTAKE_API_KEY` is set in Vercel Production**. Audit couldn't verify (Vercel
   MCP unauth'd). If it's only in local `.env.local`, the live endpoint 401s everything (safe but dead).
   Check Vercel → Settings → Env Vars → Production. Generate with `openssl rand -hex 32` if absent, put
   same value in Make.
3. **[~15-30min] EMAIL-REQUIRED POLICY** (route.ts:91): email is hard-required, but FB/IG lead ads often
   send phone-only → those 400 and the lead is lost. Decide: require email-OR-phone instead?
   (Recommended yes if running paid ad lead-gen.) Update validation + test.
4. **[~15min] CONTRACT DOC**: no doc of the payload shape — configuring Make means source-diving. Write
   a half-page: required (`location_slug`, `full_name`, `email`), optional (`phone`, `address`, `city`,
   `state`, `zip`, `project_type`, `message`, `source`, `metadata`), the `X-API-Key` header. Note: Make
   MUST set `source` explicitly (e.g. `facebook_lead_ad`) or Make leads look like generic `web_form`
   leads.

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
