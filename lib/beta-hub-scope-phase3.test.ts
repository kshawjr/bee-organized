// @vitest-environment node
//
// Fix 2 / Phase 3 — a real location as the DEFAULT for elevated users.
//
// Phases 1–2 only paid off once a location was manually picked; a fresh
// elevated login still loaded the whole tenant (~13s). This makes the win
// always-on.
//
// THE SHARP EDGE, and most of what these tests defend:
//   'All Locations' must stay REACHABLE. The picker writes the literal 'all'
//   sentinel; if that read as "no preference" the default would override the
//   choice on the very next render and the option would be unselectable. So
//   "no cookie" and "cookie says all" — previously indistinguishable, both
//   normalizing to SCOPE_ALL — are now different states.
//
// And the precedence that must not regress: a deep link still beats the
// cookie, the cookie still beats the default, and a franchise user is moved by
// none of them.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('@/lib/supabase-service', () => ({ supabaseService: {} }))
vi.mock('@/components/BeeHub', () => ({ default: () => null }))

import {
  readScopePreference,
  normalizeScopeCookie,
  resolveHubScope,
  isElevatedPickedScope,
  pickDefaultScopeLocation,
  scopeCookieString,
  SCOPE_ALL,
  LOC_OTHER_SLUG,
  ACTIVE_LIFECYCLE,
} from '@/lib/hub-scope'

const KC = { id: 'dca50888-949f-436d-b24e-b6c8a4984905', slug: 'loc_kc' }
const PDX = { id: '80ffb75d-44a9-4160-aee1-9919dd97de97', slug: 'loc_portland' }
const SCOTTS = { id: '132b42c2-9566-43cc-85dc-f90fae4ba1b1', slug: 'loc_scottsdale' }

describe('Phase 3 — unset vs explicit "all"', () => {
  it('an ABSENT cookie is "unset" — a default may apply', () => {
    expect(readScopePreference(undefined)).toEqual({ kind: 'unset' })
    expect(readScopePreference(null)).toEqual({ kind: 'unset' })
    expect(readScopePreference('')).toEqual({ kind: 'unset' })
    expect(readScopePreference('   ')).toEqual({ kind: 'unset' })
  })

  it('an EXPLICIT "all" is a preference — the default must NOT override it', () => {
    // THE test for "All Locations stays reachable". If this ever reads 'unset',
    // choosing All Locations would be undone on the next render.
    expect(readScopePreference(SCOPE_ALL)).toEqual({ kind: 'all' })
    // …and the picker really does write that exact sentinel.
    expect(scopeCookieString('all')).toContain(`=${SCOPE_ALL};`)
  })

  it('a uuid is a specific location, pending DB validation', () => {
    expect(readScopePreference(KC.id)).toEqual({ kind: 'location', uuid: KC.id })
    expect(readScopePreference(`  ${KC.id}  `)).toEqual({ kind: 'location', uuid: KC.id })
  })

  it.each([
    ['a slug', 'loc_kc'],
    ['the string undefined', 'undefined'],
    ['a truncated uuid', '80ffb75d-44a9-4160-aee1'],
    ['sql-ish injection', "' or '1'='1"],
    ['a postgrest operator payload', 'in.(1,2)'],
    ['a comma list', `${KC.id},${PDX.id}`],
  ])('unparseable (%s) is "unset", not a smuggled preference', (_l, raw) => {
    expect(readScopePreference(raw)).toEqual({ kind: 'unset' })
  })

  it('normalizeScopeCookie is unchanged — Phase 1 semantics preserved', () => {
    // Expressed in terms of readScopePreference now, so the two cannot drift.
    // Every Phase 1 case must still collapse the same way.
    expect(normalizeScopeCookie(KC.id)).toBe(KC.id)
    for (const raw of [undefined, null, '', 'all', 'loc_kc', 'undefined', "' or '1'='1", '   ']) {
      expect(normalizeScopeCookie(raw as any)).toBe(SCOPE_ALL)
    }
  })
})

describe('Phase 3 — pickDefaultScopeLocation', () => {
  const c = (loc: any, leadCount: number) => ({ id: loc.id, slug: loc.slug, leadCount })

  it('picks the largest by lead count', () => {
    expect(pickDefaultScopeLocation([c(SCOTTS, 695), c(KC, 3306), c(PDX, 1599)]))
      .toEqual({ id: KC.id, slug: KC.slug })
  })

  it('is STABLE on a tie — count desc, then id asc', () => {
    // Two locations tied on count must not alternate between page loads.
    const a = { id: '00000000-0000-4000-8000-00000000000a', slug: 'loc_a', leadCount: 500 }
    const b = { id: '00000000-0000-4000-8000-00000000000b', slug: 'loc_b', leadCount: 500 }
    expect(pickDefaultScopeLocation([b, a])).toEqual({ id: a.id, slug: 'loc_a' })
    expect(pickDefaultScopeLocation([a, b])).toEqual({ id: a.id, slug: 'loc_a' })
  })

  it('NEVER defaults into the unrouted holding pen', () => {
    // loc_other is excluded by the caller's lifecycle filter today, but
    // locations.is_active is TRUE for it — so an author reaching for the other
    // "active" column would sail past that filter and land corp in the pen.
    const other = { id: '00000000-0000-4000-8000-0000000000ff', slug: LOC_OTHER_SLUG, leadCount: 99999 }
    expect(pickDefaultScopeLocation([other, c(PDX, 10)])).toEqual({ id: PDX.id, slug: PDX.slug })
    expect(pickDefaultScopeLocation([other])).toBeNull()
  })

  it('returns null rather than landing on an EMPTY location', () => {
    // A brand-new tenant would otherwise open on an arbitrary location with
    // nothing in it, which reads as breakage. 'all' is equally fast when
    // everything is empty.
    expect(pickDefaultScopeLocation([c(KC, 0), c(PDX, 0)])).toBeNull()
    expect(pickDefaultScopeLocation([])).toBeNull()
  })

  it('ignores malformed candidates instead of trusting them', () => {
    expect(pickDefaultScopeLocation([
      { id: 'not-a-uuid', slug: 'loc_x', leadCount: 99999 } as any,
      { id: KC.id, slug: null, leadCount: NaN } as any,
      c(PDX, 5),
    ])).toEqual({ id: PDX.id, slug: PDX.slug })
  })

  it('carries the slug through — the child tables need it', () => {
    // A default with a null slug would silently drop the location-filtered
    // child path for the slug tables (childLocationFilter returns null).
    expect(pickDefaultScopeLocation([c(KC, 10)])!.slug).toBe('loc_kc')
  })
})

describe('Phase 3 — resolveHubScope precedence', () => {
  it('no cookie, no deep link → the DEFAULT, not all', () => {
    const s = resolveHubScope({
      isElevated: true, hubUserLocationId: null, validated: null, deepLink: null, fallback: KC,
    })
    expect(s).toEqual({ locationUuid: KC.id, locationSlug: KC.slug, source: 'default' })
  })

  it('a valid cookie BEATS the default (last-used wins)', () => {
    const s = resolveHubScope({
      isElevated: true, hubUserLocationId: null, validated: PDX, deepLink: null, fallback: KC,
    })
    expect(s.source).toBe('cookie')
    expect(s.locationUuid).toBe(PDX.id)
  })

  it('a deep link BEATS both (Phase 2 intact)', () => {
    const s = resolveHubScope({
      isElevated: true, hubUserLocationId: null, validated: PDX, deepLink: SCOTTS, fallback: KC,
    })
    expect(s.source).toBe('deep-link')
    expect(s.locationUuid).toBe(SCOTTS.id)
  })

  it('a deep link beats the default even with no cookie at all', () => {
    // The cold-load deep link: first login, /clients/<a lead elsewhere>.
    const s = resolveHubScope({
      isElevated: true, hubUserLocationId: null, validated: null, deepLink: SCOTTS, fallback: KC,
    })
    expect(s.source).toBe('deep-link')
    expect(s.locationUuid).toBe(SCOTTS.id)
  })

  it('NO fallback (explicit all) → all, exactly as before', () => {
    // The caller withholds the fallback when the user chose All Locations.
    const s = resolveHubScope({
      isElevated: true, hubUserLocationId: null, validated: null, deepLink: null, fallback: null,
    })
    expect(s).toEqual({ locationUuid: null, locationSlug: null, source: 'all' })
  })

  it('a malformed fallback is ignored rather than trusted', () => {
    const s = resolveHubScope({
      isElevated: true, hubUserLocationId: null, validated: null, deepLink: null,
      fallback: { id: 'nope', slug: 'loc_x' } as any,
    })
    expect(s.source).toBe('all')
  })

  it('NON-ELEVATED is moved by none of it', () => {
    const s = resolveHubScope({
      isElevated: false, hubUserLocationId: PDX.id,
      validated: KC, deepLink: KC, fallback: KC,
    })
    expect(s.locationUuid).toBe(PDX.id)
    expect(s.source).toBe('own-location')
    expect(s.locationSlug).toBeNull()
  })

  it('the child-scope gate admits "default" — or the default load gets SLOWER', () => {
    // Miss this and a defaulted load filters leads to one location but chunks
    // its 3,306 lead ids 200 at a time: 17 chunks x 9 tables, slower than the
    // whole-tenant read it replaced. A silent perf inversion, not an error.
    expect(isElevatedPickedScope({ locationUuid: KC.id, locationSlug: KC.slug, source: 'default' })).toBe(true)
    expect(isElevatedPickedScope({ locationUuid: KC.id, locationSlug: KC.slug, source: 'cookie' })).toBe(true)
    expect(isElevatedPickedScope({ locationUuid: KC.id, locationSlug: KC.slug, source: 'deep-link' })).toBe(true)
    expect(isElevatedPickedScope({ locationUuid: PDX.id, locationSlug: null, source: 'own-location' })).toBe(false)
    expect(isElevatedPickedScope({ locationUuid: null, locationSlug: null, source: 'all' })).toBe(false)
  })

  it('every elevated location source carries a slug; no other source does', () => {
    for (const s of [
      resolveHubScope({ isElevated: true, hubUserLocationId: null, validated: null, fallback: KC }),
      resolveHubScope({ isElevated: true, hubUserLocationId: null, validated: KC }),
      resolveHubScope({ isElevated: true, hubUserLocationId: null, validated: null, deepLink: KC }),
    ]) {
      expect(s.locationSlug).toBe(KC.slug)
      expect(isElevatedPickedScope(s)).toBe(true)
    }
    for (const s of [
      resolveHubScope({ isElevated: false, hubUserLocationId: PDX.id, validated: KC, fallback: KC }),
      resolveHubScope({ isElevated: true, hubUserLocationId: null, validated: null, fallback: null }),
    ]) {
      expect(s.locationSlug).toBeNull()
      expect(isElevatedPickedScope(s)).toBe(false)
    }
  })
})

describe('_hub-page wiring — Phase 3', () => {
  const src = readFileSync('app/_hub-page.tsx', 'utf8')

  it('the default is computed for everything EXCEPT an explicit All Locations', () => {
    // `kind !== 'all'` is what keeps All Locations selectable: an explicit
    // 'all' is the one preference the default must never override. A cookie
    // naming a deleted location DOES get the default — that user had picked a
    // location, so another real one beats the full-tenant load.
    expect(src).toContain(`const wantsDefault = isElevated && !scopeValidated && scopePref.kind !== 'all'`)
  })

  it('the default is resolved BEFORE the deep-link check — order is load-bearing', () => {
    // Resolve it after, and a cold load of /clients/<lead elsewhere> would skip
    // the override, apply the default, miss the lead and bounce to notfound —
    // the Phase 2 bug, reintroduced for every first-time deep link.
    const defaultAt = src.indexOf('const wantsDefault =')
    const scope0At = src.indexOf('const scope0LocationUuid =')
    const deepLinkAt = src.indexOf('let deepLinkScope')
    expect(defaultAt).toBeGreaterThan(0)
    expect(scope0At).toBeGreaterThan(defaultAt)
    expect(deepLinkAt).toBeGreaterThan(scope0At)
    // …and scope0 actually includes the fallback, or the deep-link check would
    // never fire on a cold load.
    expect(src).toContain('const scope0LocationUuid = isElevated ? (scopeValidated?.id ?? scopeFallback?.id ?? null) : null')
  })

  it('candidates come from lifecycle_status, never is_active, and exclude the pen', () => {
    // Scoped to the default-scope block: `.eq('is_active', true)` is correct
    // and unrelated on the `lookups` query further down.
    const block = src.slice(src.indexOf('const wantsDefault ='), src.indexOf('const scope0LocationUuid ='))
    expect(block).toContain(`.eq('lifecycle_status', ACTIVE_LIFECYCLE)`)
    expect(block).toContain(`.neq('location_id', LOC_OTHER_SLUG)`)
    // locations.is_active is true for 12 rows INCLUDING loc_other — using it
    // here would let a super_admin default into the unrouted holding pen.
    // Assert on CODE, not prose: the block's own comment names the column it
    // is warning against, so a raw substring check matches the warning.
    const code = block.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toContain('is_active')
  })

  it('counts are head:true, parallel, and mirror the leads query filter', () => {
    const block = src.slice(src.indexOf('const wantsDefault ='), src.indexOf('const scope0LocationUuid ='))
    expect(block).toContain('await Promise.all(')
    expect(block).toContain(`{ count: 'exact', head: true }`)
    // "Largest" must mean largest by the rows this page would actually load.
    expect(block).toContain(`.not('is_junk', 'is', true)`)
  })

  it('an explicit All Locations is the ONLY preference the default cannot override', () => {
    // Stated as behavior: with a fallback available, only kind==='all' yields
    // an unscoped load.
    const withFallback = (validated: any) => resolveHubScope({
      isElevated: true, hubUserLocationId: null, validated, deepLink: null, fallback: KC,
    })
    expect(withFallback(null).source).toBe('default')   // unset / deleted-location
    expect(withFallback(PDX).source).toBe('cookie')     // valid cookie
    // explicit 'all' → the caller passes NO fallback, so:
    expect(resolveHubScope({
      isElevated: true, hubUserLocationId: null, validated: null, deepLink: null, fallback: null,
    }).source).toBe('all')
  })

  it('the fallback reaches the resolver rather than being applied ad hoc', () => {
    expect(src).toContain('fallback: scopeFallback,')
  })

  it('initialLocFilter follows the server scope, so the client agrees on a cold load', () => {
    expect(src).toContain("const initialLocFilter = isElevated\n    ? (scope.locationUuid || 'all')\n    : hubUser.location_id || 'all'")
  })

  it('MAX_LEADS is the single leads ceiling (lowered to 5,000 in Phase 4)', () => {
    // Untouched by Phase 3; deliberately lowered by Phase 4 once 'all' stopped
    // loading leads and the ceiling began guarding one location instead of the
    // tenant. See lib/beta-hub-scope-phase4.test.ts.
    expect(src).toContain('const MAX_LEADS = 5000')
  })
})

describe('BeeHub wiring — Phase 3 (the default must be VISIBLE)', () => {
  const src = readFileSync('components/BeeHub.jsx', 'utf8')

  it('the sidebar names the active location, not just a count', () => {
    // Landing scoped with no visible cue reads as "where did my other
    // locations go?". locationLabel resolves the selected location's name from
    // initialLocations (always fetched for elevated) and IdentityScopeControl
    // renders it on the CLOSED trigger.
    expect(src).toContain("const locationLabel = locFilter === 'all'")
    expect(src).toContain("? 'All locations'")
    expect(src).toContain('locationLabel={locationLabel}')
  })

  it('All Locations is still an option in the picker', () => {
    // Phase 3 changes the DEFAULT, not the availability. Removing the option
    // is a Phase 4 decision that has not been made.
    expect(src).toContain(`applyLocScope('all')`)
    expect(src).toContain('All Locations')
  })

  it('the picker marks the active location', () => {
    expect(src).toContain('const sel = locFilter===loc.id')
  })
})

describe('IdentityScopeControl renders the scope without opening', () => {
  const src = readFileSync('components/hive/IdentityScopeControl.jsx', 'utf8')
  it('the closed trigger shows the location label', () => {
    expect(src).toContain('{locationLabel}')
  })
})
