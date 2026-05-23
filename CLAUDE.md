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
- **During active dev: push direct to main, no PR flow.** Vercel preview URLs don't work cleanly with our setup; direct push is easier to revert if needed. Switch to PR flow only when we go live.
- ALWAYS `npm run build` before pushing — production-only workflow means a broken build ships.
- Never auto-commit; never auto-push. Wait for explicit "commit" or "push" instruction from Kevin.
- Worktree branches are auto-named `claude/[adjective]-[name]-[hash]`. Don't rename; push to main via `git push origin HEAD:main`.

## Worktree gotchas
- Main checkout lives at `/Users/flightdeck/projects/clients/bee-organized/repo/`. Worktrees live under `.claude/worktrees/<name>/`.
- **Before starting code changes in a worktree, verify its base is current with main:**
  `git log --oneline -1 HEAD` (worktree) vs `cd /Users/flightdeck/projects/clients/bee-organized/repo && git fetch origin && git log --oneline -1 origin/main`
  If the worktree forked from an older commit, halt and surface this — do not apply patches built against newer main.
- Worktrees DO NOT inherit `.env.local` from the main checkout. Before first `npm run build` in a new worktree:
  `ln -s ../../../.env.local .env.local` (relative path, worktree-local; `.env.local` is already gitignored)
- `package-lock.json` sometimes shows as modified from cross-worktree npm operations. Safe to `git checkout package-lock.json` to revert if not intentionally changed.

## Files to be careful with
- .env.local — production Supabase + Jobber secrets
- middleware.ts — auth gating, affects every request
- /app/api/ — server routes touching real production data

## Drip system (cron)
- Vercel cron hits `/api/cron/send-drips` hourly (see vercel.json).
- Endpoint requires `CRON_SECRET` env var. Vercel cron sends it as
  `Authorization: Bearer <CRON_SECRET>`; manual testing also accepts
  `?secret=<value>`. Set in Vercel project settings (Production +
  Preview). Generate with `openssl rand -hex 32`.
- Without `CRON_SECRET`, the route returns 500 — fail-closed.

## Known issues / tech debt
- Next.js 14.2.3 has a security vulnerability — planned upgrade to latest patched 14.x
- npm audit shows 1 critical + 1 moderate — do not run `npm audit fix --force`, fix deliberately

## Context
- Repo renamed from bee-hub-v2 → bee-organized on 2026-04-20
- Lives on the flightdeck mini at ~/projects/clients/bee-organized/repo/
