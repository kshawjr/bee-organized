# Bee Hub — Prototype to Next.js Migration

## What's in this folder

Drop these files into your ~/bee-organized project:

```
app/
  page.tsx          → redirects / to /hive
  layout.tsx        → root layout with fonts + metadata
  globals.css       → all CSS (replaces old globals.css)
  hive/page.tsx     → Hive screen
  clients/page.tsx  → Clients screen
  contacts/page.tsx → Contacts / Partners screen
  reports/page.tsx  → Reports screen
  settings/page.tsx → Settings screen
  admin/page.tsx    → Admin screen
  onboarding/page.tsx → Onboarding screen

components/
  BeeHubApp.tsx     → Client wrapper (dynamic import, no SSR)
  BeeHub.jsx        → The full prototype (940KB — the whole app)
```

## Steps

1. **Wipe** your old `app/` pages and `components/` (keep `lib/`, `api/`, `.env.local`)
2. **Copy** everything from this folder into `~/bee-organized`
3. **Install** nothing new — uses only React (already installed)
4. **Push** to GitHub → Vercel auto-deploys

## What works immediately
- Full UI, all screens, all interactions
- Fake/seed data (same as prototype)

## Wiring plan (next sessions)
Each screen gets wired one at a time:
1. `/hive` → real Supabase leads data (already have API route)
2. `/clients` → Kanban + list from service_requests.stage
3. `/settings` → real location settings
4. etc.
