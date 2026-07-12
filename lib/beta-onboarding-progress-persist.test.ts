// Onboarding progress persistence + fail-loud — the live regression:
// a freshly-accepted manager landed on the 2-step checklist ("Welcome aboard"
// + "Complete your profile"), marked a step complete, and it never stuck —
// "0 of 2" on every reload — with no error shown.
//
// Root cause (confirmed): manager / lite_user run the employee_setup flow.
// The route writes their completion ONLY to the onboarding_progress audit log
// and deliberately SKIPS the owner-owned locations.onboarding_state cache. The
// client seeded completedSteps EXCLUSIVELY from that location cache, so the
// employee's progress had no read-back path and reverted on reload. The write
// half was fire-and-forget with a .catch that only caught network errors
// (fetch never rejects on 4xx/5xx), so a genuine reject was invisible too.
//
// The contract now:
//   A) route GET returns the authed user's completedSteps from the audit log
//      (the read-back path), for owner_setup AND employee_setup
//   B) route POST returns the authoritative completedSteps so the client can
//      reconcile / detect failure; owner cache write stays owner_setup-only
//   C) client hydrates from GET on mount (union-merge, never regresses a seed)
//   D) markDone FAILS LOUD: on a rejected save it rolls the step back, reopens
//      it, and toasts an error instead of silently appearing to do nothing;
//      the non-owner checklist renders that toast
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const routeSrc = readFileSync(
  join(process.cwd(), 'app/api/onboarding/progress/route.ts'),
  'utf8',
)
const beeSrc = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')

// ── A) route: read-back path + type derivation ───────────────────────────
describe('progress route — read-back (GET)', () => {
  it('exposes a GET handler', () => {
    expect(routeSrc).toMatch(/export async function GET\(/)
  })

  it('manager + lite_user derive employee_setup; everyone else owner_setup', () => {
    expect(routeSrc).toContain('function onboardingTypeFor(')
    expect(routeSrc).toMatch(
      /role === 'lite_user' \|\| role === 'manager'\s*\?\s*'employee_setup'\s*:\s*'owner_setup'/,
    )
  })

  it('reads completed steps from the onboarding_progress audit log by user + type', () => {
    expect(routeSrc).toContain('async function readCompletedSteps(')
    expect(routeSrc).toContain("from('onboarding_progress')")
    expect(routeSrc).toMatch(/\.eq\('user_id', userId\)/)
    expect(routeSrc).toMatch(/\.eq\('onboarding_type', onboardingType\)/)
  })

  it('GET still requires a real hub_users profile — auth is not weakened', () => {
    const get = routeSrc.slice(routeSrc.indexOf('export async function GET('))
    expect(get).toContain('await requireAuth()')
    expect(get).toContain('await getHubUser()')
    expect(get).toMatch(/if \(!hubUser\)[\s\S]*status: 403/)
  })
})

// ── B) route: POST returns authoritative set; cache stays owner-only ──────
describe('progress route — POST reconcile + owner-only cache', () => {
  it('POST returns completedSteps so the client can reconcile / detect failure', () => {
    const post = routeSrc.slice(routeSrc.indexOf('export async function POST('))
    expect(post).toContain('const completedSteps = await readCompletedSteps(')
    expect(post).toMatch(/completedSteps: completedSteps \|\| undefined/)
  })

  it('the locations.onboarding_state cache write stays owner_setup-only (managers never mutate it)', () => {
    expect(routeSrc).toMatch(
      /if \(onboardingType === 'owner_setup' && hubUser\.location_id\)/,
    )
  })
})

// ── C) client: hydrate from the audit log on mount ───────────────────────
describe('BeeHub — read-back hydrate', () => {
  it('fetches GET /api/onboarding/progress on mount and union-merges the result', () => {
    expect(beeSrc).toContain('function mergeCompletedSteps(server)')
    expect(beeSrc).toMatch(/fetch\('\/api\/onboarding\/progress'\)/)
    expect(beeSrc).toContain('mergeCompletedSteps(json?.completedSteps)')
    // union only ever ADDS completions — can't regress the lazy-init seed
    expect(beeSrc).toMatch(/if \(server\[k\] && !next\[k\]\) \{ next\[k\] = true; changed = true \}/)
  })
})

// ── D) client: fail loud ─────────────────────────────────────────────────
describe('BeeHub — persistStep / markDone fail loud', () => {
  it('persistStep inspects res.ok instead of swallowing non-2xx', () => {
    expect(beeSrc).toContain('async function persistStep(')
    expect(beeSrc).toMatch(/if \(!res\.ok\)/)
    // the old silent pattern must be gone: no bare fire-and-forget POST whose
    // only handling is a network-only .catch
    expect(beeSrc).not.toMatch(
      /body: JSON\.stringify\(\{\s*step: stepId,[\s\S]*?\}\),\s*\}\)\.catch\(/,
    )
  })

  it('markDone rolls back + reopens + toasts an error when the save is rejected', () => {
    const md = beeSrc.slice(beeSrc.indexOf('async function markDone('))
    expect(md).toContain('const r = await persistStep(id, metadata)')
    expect(md).toMatch(/if \(!r\.ok\)/)
    expect(md).toContain('delete next[id]')
    expect(md).toContain('setActiveStepOpen(id)')
    expect(md).toMatch(/setToast\(\{ kind: 'error'/)
  })

  it('the non-owner checklist renders the toast so the error is actually visible', () => {
    // the fix added a toast surface to the previously toast-less employee path
    const start = beeSrc.indexOf('Non-owner: simple checklist')
    const end = beeSrc.indexOf('Owner: welcome intro')
    const nonOwner = beeSrc.slice(start, end)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(nonOwner).toContain('{toast && <InlineToast {...toast} />}')
  })
})
