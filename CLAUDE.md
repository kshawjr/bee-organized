# Bee Organized

Multi-tenant client web app — Next.js + Supabase, with Jobber integration.

## Stack
- Next.js 14.2.3 (App Router)
- Supabase (@supabase/ssr) for auth and DB
- TypeScript
- Deployed via Vercel

## Major features
- Auth (Supabase, /auth/login)
- Admin area
- Per-location management (onboarding, subscriptions)
- Jobber OAuth integration + client import pipeline
- Reports, contacts, clients, hive, settings sections

## Local commands
- `npm install` to install
- `npm run build` to verify production build
- `npm run lint` for linting
- `npm run dev` if local server is needed (rarely used — production-only workflow)

## Conventions
- Branch naming: feature/[short-desc] or fix/[short-desc]
- Run `npm run build` before pushing if changes are substantial
- PRs target main; merge auto-deploys via Vercel
- Production-only workflow — local dev server rarely used

## Files to be careful with
- .env.local — production Supabase + Jobber secrets
- middleware.ts — auth gating, affects every request
- /app/api/ — server routes touching real production data

## Known issues / tech debt
- Next.js 14.2.3 has a security vulnerability — planned upgrade to latest patched 14.x
- npm audit shows 1 critical + 1 moderate — do not run `npm audit fix --force`, fix deliberately

## Context
- Repo renamed from bee-hub-v2 → bee-organized on 2026-04-20
- Lives on the flightdeck mini at ~/projects/clients/bee-organized/repo/
