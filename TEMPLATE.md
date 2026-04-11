# Hub Template — Blue Maven Tech

Reusable franchise operations hub template. Clone this for each new client hub.

## Stack
- Next.js 14.2.3 (App Router + TypeScript)
- Supabase (auth + database)
- CSS variables (theme system built in)
- Vercel deployment

## Spin Up a New Hub (30 min)

### 1. Clone this repo
git clone https://github.com/kshawjr/bee-hub new-hub-name
cd new-hub-name
npm install

### 2. Create Supabase project
- supabase.com → New Project
- Run migration: supabase/migrations/001_initial_schema.sql
- Copy URL, anon key, service role key

### 3. Configure environment
cp .env.example .env.local
# Fill in Supabase keys and app URL

### 4. Customize branding
- globals.css → change --brand color
- app/layout.tsx → change title
- app/dashboard/layout.tsx → change logo/name

### 5. Create first user
In Supabase SQL Editor:
INSERT INTO hub_users (id, email, role, is_active)
SELECT id, email, 'super_user', true
FROM auth.users WHERE email = 'your@email.com';

### 6. Deploy to Vercel
- New Project → import GitHub repo
- Add environment variables
- Deploy

## Hubs Built on This Template
- Bee Hub — Bee Organized franchise ops (bee-hub-kappa.vercel.app)
- TPF Hub — The Perfect Franchise (coming soon)
- CCG Hub — Corporate Cleaning Group (coming soon)

## Brand Colors
- Bee Organized: #F5A623 (amber)
- TPF: TBD
- CCG: TBD

## Architecture
- /login — public auth page
- /dashboard — protected, requires hub_users row
- /dashboard/locations — franchise unit management
- /dashboard/sync — Zoho ↔ Jobber sync log
- middleware.ts — Supabase session management
- lib/auth.ts — requireAuth() helper
- components/ThemeToggle.tsx — light/dark/system theme

## Database Schema
Tables: hub_users, locations, sync_log, import_jobs, jobber_oauth_states
Migration: supabase/migrations/001_initial_schema.sql

## Adding New Pages
1. Create app/dashboard/your-page/page.tsx
2. Add requireAuth() at the top
3. Add link to app/dashboard/layout.tsx sidebar
4. Build and test locally before pushing
