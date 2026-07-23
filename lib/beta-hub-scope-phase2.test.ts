// @vitest-environment node
//
// Fix 2 / Phase 2 — the three gaps Phase 1's server-side scoping opened.
//
//  1. DEEP LINKS. /clients/<id> for a lead outside the selected scope used to
//     load a page without it and bounce to /clients?notfound=1 — a "not found"
//     toast on a lead that plainly exists, on the path lead-notification emails
//     use. The scope now follows the lead. The FENCE must survive that: a
//     franchise user deep-linking another location's lead still bounces.
//
//  2. THE loc_other TRANSFER QUEUE. It was derived from the loaded people
//     graph, so selecting any real location silently emptied Leslie's routing
//     queue — the work still there, the surface just quiet. Now fetched outside
//     the scope, and still elevated-only.
//
//  3. ⌘K SCOPE LABEL. Honesty, not capability: the search says where it looked.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('@/lib/supabase-service', () => ({ supabaseService: {} }))
vi.mock('@/components/BeeHub', () => ({ default: () => null }))

import {
  resolveHubScope,
  isElevatedPickedScope,
  LOC_OTHER_SLUG,
  TRANSFER_QUEUE_MAX,
} from '@/lib/hub-scope'

const KC = { id: '80ffb75d-44a9-4160-aee1-9919dd97de97', slug: 'loc_kc' }
const PDX = { id: '1b62628f-e3be-4024-be2d-e8179f09f740', slug: 'loc_portland' }

describe('Phase 2 — deep-link scope precedence', () => {
  it('an elevated deep link WINS over the cookie', () => {
    // The cookie says KC; the URL names a Portland lead. Portland wins, because
    // honoring the cookie would 404 a lead that exists.
    const s = resolveHubScope({
      isElevated: true, hubUserLocationId: null,
      validated: KC, deepLink: PDX,
    })
    expect(s).toEqual({ locationUuid: PDX.id, locationSlug: PDX.slug, source: 'deep-link' })
  })

  it('no deep link → the cookie still decides (Phase 1 behavior intact)', () => {
    const s = resolveHubScope({ isElevated: true, hubUserLocationId: null, validated: KC, deepLink: null })
    expect(s.source).toBe('cookie')
    expect(s.locationUuid).toBe(KC.id)
  })

  it('a deep link with no cookie scopes to the lead’s location', () => {
    const s = resolveHubScope({ isElevated: true, hubUserLocationId: null, validated: null, deepLink: PDX })
    expect(s.locationUuid).toBe(PDX.id)
    expect(s.source).toBe('deep-link')
  })

  it('THE FENCE: a non-elevated user is unmoved by a deep link', () => {
    // The escalation attempt: a Portland franchise user crafts /clients/<a KC
    // lead id>. The server must not scope them to KC — and because their
    // initialPeople stays Portland-only, the notfound guard still fires.
    const s = resolveHubScope({
      isElevated: false, hubUserLocationId: PDX.id,
      validated: KC, deepLink: KC,
    })
    expect(s.locationUuid).toBe(PDX.id)
    expect(s.source).toBe('own-location')
    expect(s.locationSlug).toBeNull()
  })

  it('a malformed deep-link location is ignored rather than trusted', () => {
    const s = resolveHubScope({
      isElevated: true, hubUserLocationId: null, validated: KC,
      deepLink: { id: 'not-a-uuid', slug: 'loc_x' } as any,
    })
    expect(s.source).toBe('cookie')
    expect(s.locationUuid).toBe(KC.id)
  })

  it('the child-scope gate admits both elevated picked sources and no others', () => {
    // 'deep-link' must take the location-filtered child path like 'cookie' —
    // otherwise a deep-linked load would chunk 3,306 lead ids by hand.
    expect(isElevatedPickedScope({ locationUuid: KC.id, locationSlug: KC.slug, source: 'deep-link' })).toBe(true)
    expect(isElevatedPickedScope({ locationUuid: KC.id, locationSlug: KC.slug, source: 'cookie' })).toBe(true)
    // A franchise user's own-location scope must NOT — Phase 1's contract is
    // that their load is untouched.
    expect(isElevatedPickedScope({ locationUuid: PDX.id, locationSlug: null, source: 'own-location' })).toBe(false)
    expect(isElevatedPickedScope({ locationUuid: null, locationSlug: null, source: 'all' })).toBe(false)
  })

  it('only elevated picked scopes ever carry a slug', () => {
    for (const s of [
      resolveHubScope({ isElevated: false, hubUserLocationId: PDX.id, validated: KC, deepLink: KC }),
      resolveHubScope({ isElevated: false, hubUserLocationId: null, validated: KC, deepLink: KC }),
      resolveHubScope({ isElevated: true, hubUserLocationId: null, validated: null, deepLink: null }),
    ]) {
      expect(s.locationSlug).toBeNull()
      expect(isElevatedPickedScope(s)).toBe(false)
    }
  })
})

describe('Phase 2 — transfer queue constants', () => {
  it('the holding-pen slug is the one the transfer endpoints use', () => {
    expect(LOC_OTHER_SLUG).toBe('loc_other')
    // Cross-check against the route that excludes it as a transfer TARGET, so
    // the two can never drift apart.
    const route = readFileSync('app/api/locations/transfer-targets/route.ts', 'utf8')
    expect(route).toContain(`.neq('location_id', 'loc_other')`)
  })
  it('the queue is bounded', () => {
    expect(TRANSFER_QUEUE_MAX).toBeGreaterThan(0)
    expect(TRANSFER_QUEUE_MAX).toBeLessThanOrEqual(200)
  })
})

describe('_hub-page wiring — Phase 2', () => {
  const src = readFileSync('app/_hub-page.tsx', 'utf8')

  it('the deep-link lookup is elevated-only and only runs when a scope is active', () => {
    expect(src).toContain('if (isElevated && scope0LocationUuid && initialSelectedLeadId && isUuid(initialSelectedLeadId))')
  })

  it('the deep-link lookup mirrors the leads query’s junk filter', () => {
    // A junked lead lives in the bin, not initialPeople. Switching scope for
    // one would move the whole page and STILL bounce the user.
    const block = src.slice(src.indexOf('deepLinkScope'), src.indexOf('const scope = resolveHubScope'))
    expect(block).toContain(`.eq('id', initialSelectedLeadId)`)
    expect(block).toContain(`.not('is_junk', 'is', true)`)
    // Reads BOTH location forms off the leads row — one lookup, and no chance
    // of pairing a uuid with another location's slug.
    expect(block).toContain(`.select('id, location_uuid, location_id')`)
  })

  it('the override only fires when the lead is genuinely elsewhere', () => {
    expect(src).toContain('leadRow.location_uuid !== scope0LocationUuid')
  })

  it('the deep-link scope reaches the resolver — not applied ad hoc', () => {
    // One scope resolution for the whole request. A second, separate override
    // applied to some queries and not others is precisely the half-scoped
    // payload Phase 1 was careful to make impossible.
    expect(src).toContain('deepLink: deepLinkScope,')
    expect(src).toContain('isElevatedPickedScope(scope) && scope.locationUuid')
  })

  it('the notfound redirect still exists — a nonexistent lead must still bounce', () => {
    expect(src).toContain(`redirect('/clients?notfound=1')`)
    expect(src).toContain('const found = initialPeople.some((p: any) => p.id === initialSelectedLeadId)')
  })

  it('the transfer queue is elevated-only and ignores the selected scope', () => {
    const block = src.slice(src.indexOf('loc_other transfer queue'), src.indexOf('/clients/[id] passes initialSelectedLeadId'))
    expect(block).toContain('if (isElevated) {')
    expect(block).toContain(`.eq('location_id', LOC_OTHER_SLUG)`)
    expect(block).toContain(`.not('is_junk', 'is', true)`)
    expect(block).toContain('.limit(TRANSFER_QUEUE_MAX)')
    // The whole point: it must NOT carry the page's location filter.
    expect(block).not.toContain('scopeLocationUuid)')
  })

  it('the transfer queue is not re-queried when the scope already loaded it', () => {
    expect(src).toContain('const alreadyLoaded = !scopeLocationUuid || scope.locationSlug === LOC_OTHER_SLUG')
  })

  it('both new props reach BeeHub', () => {
    expect(src).toContain('initialTransferPeople={initialTransferPeople}')
    expect(src).toContain('initialScopeLocationId={scope.locationUuid}')
  })
})

describe('BeeHub wiring — Phase 2', () => {
  const src = readFileSync('components/BeeHub.jsx', 'utf8')

  it('the cookie reconciles to the scope the SERVER used, without refreshing', () => {
    // Server Components cannot write cookies, so a server-side scope override
    // (deep link) has to be persisted here or the next navigation undoes it.
    expect(src).toContain("const serverScope = initialScopeLocationId === undefined ? null : (initialScopeLocationId || SCOPE_ALL)")
    // undefined (no server prop — a demo/test mount) must NOT write a cookie:
    // that would silently reset a real user's scope to 'all'. null (the server
    // saying "all locations") must.
    expect(src).toContain('if (serverScope === null) return')
    expect(src).toContain('document.cookie = scopeCookieString(serverScope)')
    // A refresh here would loop: the render in front of the user is already
    // the correct one.
    const block = src.slice(src.indexOf('const serverScope ='), src.indexOf('[view-as] lifecycle instrumentation'))
    expect(block).not.toContain('router.refresh()')
  })

  it('Home reads the dedicated queue, not the location-scoped people array', () => {
    expect(src).toContain('const transferLeads = isElevated ? (transferPeople || []).filter(isLivePersonH) : []')
    // The old form filtered scopedPeopleH — which is exactly what emptied under
    // a location scope.
    expect(src).not.toContain('scopedPeopleH.filter(p => isLivePersonH(p) && p.atLocOther)')
  })

  it('transferPeople is recomputed when it changes (memo dep)', () => {
    expect(src).toContain('}, [people, engagements, transferPeople, effectiveLocId, isElevated, canSeeFinancials])')
  })

  it('the queue is role-gated where isElevated lives — view-as cannot leak it', () => {
    // Under view-as the SERVER session is still super_admin, so the prop
    // arrives populated even though the client role reads 'franchise'.
    expect(src).toContain('transferPeople={isElevated ? transferPeople : []}')
  })

  it('the queue prop-syncs after a scope switch like the other server arrays', () => {
    expect(src).toContain('}, [initialTransferPeople])')
  })

  it('⌘K names the scope it is actually searching', () => {
    expect(src).toContain(`scopeLabel={locFilter === 'all' ? 'all locations' : (selectedLoc?.name || currentLocation?.name || 'this location')}`)
    expect(src).toContain('placeholder={`Search ${scopeLabel}…`}')
    expect(src).toContain('Searching {scopeLabel}')
    // The no-results state is the one that most needs it: without a scope name
    // it reads as "this lead does not exist".
    expect(src).toContain('Searched {scopeLabel}')
  })
})

describe('Inbox wiring — Phase 2', () => {
  const src = readFileSync('components/hive/InboxScreen.jsx', 'utf8')

  it('the transfer bucket is built from transferPeople, not the scoped array', () => {
    expect(src).toContain('for (const p of (transferPeople || [])) {')
    // The old collector pulled loc_other rows out of the location-scoped loop.
    expect(src).not.toContain('if (p.atLocOther) { transfer.push(p); continue }')
  })

  it('loc_other rows are still excluded from New/Attempting', () => {
    // On an 'all' load these rows are in BOTH arrays; dropping them from the
    // people loop is what stops them rendering twice.
    expect(src).toContain('if (p.atLocOther) continue')
  })

  it('the transfer bucket honors the same soft removals as every other section', () => {
    const block = src.slice(src.indexOf('for (const p of (transferPeople || [])) {'))
    for (const guard of ['junkedIds.has(p.id)', 'snoozedIds.has(p.id)', 'dismissedIds.has(p.id)', 'transferredIds.has(p.id)', 'passesInboxFilters(p)']) {
      expect(block.slice(0, 800)).toContain(guard)
    }
  })

  it('transferPeople is a memo dependency', () => {
    expect(src).toContain('}, [scoped, transferPeople, openClientIds')
  })
})

describe('HiveShell wiring — Phase 2', () => {
  const src = readFileSync('components/hive/HiveShell.jsx', 'utf8')
  it('passes the queue straight through to the Inbox', () => {
    expect(src).toContain('transferPeople = [],')
    expect(src).toContain('transferPeople={transferPeople}')
  })
  it('does NOT merge it into people — every people consumer filters by location', () => {
    expect(src).not.toContain('[...people, ...transferPeople]')
    expect(src).not.toContain('people.concat(transferPeople)')
  })
})
