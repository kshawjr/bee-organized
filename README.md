# Bee Hub — Bee Organized Franchise Operations Platform

## Stack
- Next.js 14.2.3 (App Router + TypeScript)
- Supabase (auth + hub_users table)
- Zoho CRM (source of truth — all location/deal/contact data)
- Jobber GraphQL API (field service management)
- Vercel (hosting)

## Local Dev
```bash
cd ~/bee-organized
npm run dev
# runs on http://localhost:3000
```

## Deployed
- Production: https://bee-hub-kappa.vercel.app
- Supabase: pcuycyelxxkxahlxdewl.supabase.co

## Architecture
- Zoho CRM = source of truth (locations, deals, contacts, requests)
- Supabase = hub_users only (auth + roles)
- Hub reads/writes Zoho directly via API
- Jobber tokens stored in Zoho Locations module

## User Roles
| Role | Access |
|------|--------|
| super_admin | Everything, all locations, import override, dev tools |
| admin | Everything except import override, all locations |
| owner | Their location only, full access |
| lite_user | Their location only, read-only |

## Key Files
```
app/
  login/page.tsx + login.css     — Branded login
  dashboard/
    layout.tsx                   — Dark sidebar, role-aware nav
    page.tsx                     — Role-aware overview dashboard
    locations/
      page.tsx                   — Unified table, clickable rows
      [id]/
        page.tsx                 — Location detail (hero, details, jobber)
        ImportSection.tsx        — Import UI (50/batch, dev mode)
    sync/page.tsx                — Sync log with search
    admin/                       — (pending) Admin hub
  api/
    jobber/
      connect/route.ts           — OAuth initiate
      callback/route.ts          — OAuth exchange
      import/route.ts            — Import engine
    zoho/
      locations/route.ts         — GET all locations
    sync-log/route.ts            — GET sync log
lib/
  auth.ts                        — requireAuth, getHubUser, role helpers
  zoho.ts                        — getZohoLocations, getZohoLocation
  jobber.ts                      — getValidJobberToken, jobberQuery
  sync-log.ts                    — writeSyncLog
  supabase.ts / supabase-server.ts
components/
  SearchSelect.tsx               — Portal dropdown
  ThemeToggle.tsx
```

## Zoho Key IDs
- CRM Admin user ID: 6426180000000482001
- Deal Layout ID: 6426180000010735010
- Pipeline: "Bee Organized Zee Bee"
- Test Location ID: loc_test / Zoho record: 6426180000013804526
- Kansas City ID: loc_kc / Zoho record: 6426180000004242061

## Jobber
- API URL: https://api.getjobber.com/api/graphql
- API Version: 2025-04-16
- OAuth URL: https://api.getjobber.com/api/oauth/token
- Client ID: b8707d46-f063-40a1-a758-89761e0b8620
- Token refresh: hub validates via test query, only refreshes if invalid
- Token_Expiry field owned by Deluge (do NOT write from hub)

## Token Refresh Strategy
- Hub tests token with `{ account { id } }` query
- If valid → use as-is, skip refresh
- If invalid → refresh via Jobber OAuth, save new tokens to Zoho
- Do NOT write Token_Expiry or Token_Expiry_Display (Deluge owns these)
- Zoho currenttime.toLong() runs ~2hrs ahead of JS Date.now() — never compare epochs cross-system

## Import Engine
- Preview → shows stage breakdown with bar chart
- Import → 50 records per batch
- Continue → manual trigger for next batch
- Dev Mode (super_admin only) → 10 newest records per stage
- Stages: Final Processing > Job in Progress > Quote > Assessment Scheduled > Stagnant

## ✅ Done
- [x] Login page (Bee Organized branded)
- [x] Role-aware dashboard
- [x] Locations list (unified table, clickable, owner name, filters)
- [x] Location detail (hero header, details, paths & links, Jobber)
- [x] Jobber OAuth connect flow
- [x] Smart token refresh (lib/jobber.ts)
- [x] Import engine (50/batch, manual continue, dev mode)
- [x] Sync log (writes on import, searchable)
- [x] All 4 roles + auth helpers
- [x] Dark sidebar with Main/Admin/Dev sections

## ⚠️ Known Issues
- SearchSelect dropdown overlaps table rows visually (functional but ugly)
- Sync log location scoping bug (owner needs to be scoped to location)
- Test Location token expires frequently during dev testing

## 📋 Pending
- [ ] Admin page (/dashboard/admin) — users, invite flow, settings
- [ ] Franchise owner invite flow — email invite + role assignment
- [ ] Send to Jobber — push Zoho requests to Jobber from hub
- [ ] Import lock — Jobber_Import_Complete flag after full import
- [ ] Kansas City full import — reconnect + run
- [ ] Fix SearchSelect dropdown overlap
- [ ] Fix sync log owner scoping
- [ ] Deploy latest to Vercel

## Deluge Functions (Zoho)
- jobber_token_refresh — refreshes Jobber token, owns Token_Expiry field
- request_convert — converts Request to Account/Contact/Deal
- send_to_jobber2 — pushes Zoho requests to Jobber (existing, not yet in hub)