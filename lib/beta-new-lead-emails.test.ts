// @vitest-environment node
// Unified "New lead emails" — PART 1 project-type notification routing.
//
// Pins:
//   • category encode/decode: 'all' | JSON label set | legacy moving/organizing.
//   • filterRecipientsByProjectType: toggle-ON filters by the lead's project
//     type; a type claimed by a specific recipient goes ONLY to that recipient
//     (+ 'all' recipients); an UNCLAIMED type → whole team ("everything else").
//   • NEVER-DROP: a filter that empties falls back to the whole team, then to
//     the full base list — a lead notification never reaches no one.
//   • resolveLeadRecipients: split OFF (or no lead) → everyone subscribed;
//     split ON → filtered. Forward-safe: a missing toggle column reads false.
//   • legacy 'moving'/'organizing' rows still resolve (drip-category match).
//   • Externals are NEVER senders (sender pool is hub_users owner/manager only).
//   • Migration + routes wiring (source sweep).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── Mock supabaseService honoring .eq()/.in() (array-access resolvers) ──────
const tableData = vi.hoisted(() => ({ current: {} as Record<string, any[]> }))
vi.mock('@/lib/supabase-service', () => {
  const makeBuilder = (table: string) => {
    const filters: any[] = []
    const b: any = {}
    b.select = () => b
    b.order = () => b
    b.update = () => b
    b.eq = (col: string, val: any) => { filters.push(['eq', col, val]); return b }
    b.in = (col: string, vals: any[]) => { filters.push(['in', col, vals]); return b }
    const resolve = () => {
      let data = tableData.current[table] || []
      for (const [op, col, val] of filters) {
        data = op === 'in'
          ? data.filter((r: any) => val.includes(r[col]))
          : data.filter((r: any) => r[col] === val)
      }
      return { data, error: null }
    }
    b.then = (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej)
    return b
  }
  return { supabaseService: { from: (t: string) => makeBuilder(t) } }
})
vi.mock('@/lib/zoho', () => ({
  getZohoLocationNotificationContacts: vi.fn(async () => []),
}))

import {
  parseCategory,
  serializeCategory,
  categoryMatchesLead,
  isSpecificSelection,
  selectedTypes,
} from '@/lib/notification-project-types'
import {
  filterRecipientsByProjectType,
  resolveLeadRecipients,
  type EffectiveRecipient,
} from '@/lib/notification-recipients'

// ── Category encode / decode ────────────────────────────────────────────────
describe('category encode/decode', () => {
  it("null / '' / 'all' → all leads", () => {
    for (const raw of [null, undefined, '', 'all']) {
      const p = parseCategory(raw as any)
      expect(p.kind).toBe('all')
    }
  })
  it('JSON array → specific type set', () => {
    const p = parseCategory('["Moving","Estate Cleanout"]')
    expect(p).toEqual({ kind: 'types', types: ['Moving', 'Estate Cleanout'] })
    expect(selectedTypes('["Moving","Estate Cleanout"]')).toEqual(['Moving', 'Estate Cleanout'])
  })
  it('comma-separated fallback parses too', () => {
    expect(parseCategory('Moving, Downsizing')).toEqual({ kind: 'types', types: ['Moving', 'Downsizing'] })
  })
  it('legacy moving/organizing resolve to drip-category selections', () => {
    expect(parseCategory('moving').kind).toBe('legacy-move')
    expect(parseCategory('organizing').kind).toBe('legacy-general')
  })
  it('serialize round-trips (sorted, deduped); empty → all', () => {
    expect(serializeCategory({ all: true })).toBe('all')
    expect(serializeCategory({ all: false, types: [] })).toBe('all')
    expect(serializeCategory({ all: false, types: ['B', 'A', 'A'] })).toBe('["A","B"]')
  })
  it('isSpecificSelection: only explicit type sets claim types', () => {
    expect(isSpecificSelection('all')).toBe(false)
    expect(isSpecificSelection('moving')).toBe(false)
    expect(isSpecificSelection('["Moving"]')).toBe(true)
  })
})

describe('categoryMatchesLead', () => {
  it("'all' matches any lead", () => {
    expect(categoryMatchesLead('all', 'Moving', 'move')).toBe(true)
    expect(categoryMatchesLead('all', null, 'general')).toBe(true)
  })
  it('type set matches on the exact project_type label', () => {
    expect(categoryMatchesLead('["Moving"]', 'Moving', 'move')).toBe(true)
    expect(categoryMatchesLead('["Moving"]', 'Downsizing', 'general')).toBe(false)
    expect(categoryMatchesLead('["Moving"]', null, 'general')).toBe(false)
  })
  it('legacy values match on drip category', () => {
    expect(categoryMatchesLead('moving', 'Moving', 'move')).toBe(true)
    expect(categoryMatchesLead('moving', 'Closet', 'general')).toBe(false)
    expect(categoryMatchesLead('organizing', 'Closet', 'general')).toBe(true)
  })
})

// ── Send-time filter ────────────────────────────────────────────────────────
const U = (email: string, category = 'all'): EffectiveRecipient => ({
  source: 'user', hub_user_id: 'id-' + email, name: email.split('@')[0], email, category,
})
const E = (email: string, category = 'all'): EffectiveRecipient => ({
  source: 'external', hub_user_id: null, name: email.split('@')[0], email, category,
})

describe('filterRecipientsByProjectType', () => {
  it('a CLAIMED type goes only to its assignee (+ all-leads recipients), not the whole team', () => {
    const base = [U('owner@x.com', '["Moving"]'), U('mgr@x.com', 'all'), U('other@x.com', '["Downsizing"]')]
    const out = filterRecipientsByProjectType(base, 'Moving', 'move').map(r => r.email).sort()
    expect(out).toEqual(['mgr@x.com', 'owner@x.com']) // other@ (Downsizing only) excluded
  })
  it('an UNCLAIMED type falls to the whole team (everything-else) + all-leads externals', () => {
    const base = [U('owner@x.com', '["Moving"]'), U('mgr@x.com', '["Moving"]'), E('ext@x.com', 'all')]
    // 'Downsizing' is claimed by nobody → everything-else → whole team (both users) + ext(all)
    const out = filterRecipientsByProjectType(base, 'Downsizing', 'general').map(r => r.email).sort()
    expect(out).toEqual(['ext@x.com', 'mgr@x.com', 'owner@x.com'])
  })
  it('NEVER-DROP: a filter that would empty falls back to the full list when there are no users', () => {
    // Only externals, each claiming a type none of which match, no users →
    // fall back to the full base list (never zero).
    const out = filterRecipientsByProjectType(
      [E('a@x.com', '["Moving"]'), E('b@x.com', '["Estate"]')],
      'Downsizing', 'general',
    )
    expect(out.map(r => r.email).sort()).toEqual(['a@x.com', 'b@x.com'])
  })
  it('never-drop prefers the whole team over the full list when users exist', () => {
    const base = [U('owner@x.com', '["Moving"]'), E('ext@x.com', '["Estate"]')]
    const out = filterRecipientsByProjectType(base, 'Downsizing', 'general').map(r => r.email).sort()
    // Downsizing unclaimed → everything-else → whole team (owner). ext (Estate) excluded.
    expect(out).toEqual(['owner@x.com'])
  })
})

// ── Cross-table twin collapse ───────────────────────────────────────────────
// The Zoho seed/top-up put owner emails into lead_notification_externals that
// also belong to a hub_user at the location (39 rows in prod, 2026-07-19). The
// twin arrives with category 'all', so left in the array it matches every lead
// — the person could never be routed away from anything. One person, one
// entry: hub_user wins, their configured claim survives.
describe('filterRecipientsByProjectType — duplicated owner (hub_user + external twin)', () => {
  it('a duplicated owner resolves to ONE recipient — source user, claim intact', () => {
    const out = filterRecipientsByProjectType(
      [U('angie@x.com', '["Moving"]'), E('angie@x.com', 'all')],
      'Moving', 'move',
    )
    expect(out).toHaveLength(1)
    expect(out[0].source).toBe('user')
    expect(out[0].hub_user_id).toBe('id-angie@x.com')
    expect(out[0].category).toBe('["Moving"]')
  })
  it("the 'all' twin cannot leak them into a type someone ELSE claims", () => {
    const base = [
      U('angie@x.com', '["Moving"]'),
      U('bob@x.com', '["Organizing"]'),
      E('angie@x.com', 'all'), // the seeded twin — without collapse it matches everything
    ]
    const out = filterRecipientsByProjectType(base, 'Organizing', 'general').map(r => r.email)
    expect(out).toEqual(['bob@x.com'])
  })
  it('collapse is case-insensitive and order-independent — external listed first still loses', () => {
    const out = filterRecipientsByProjectType(
      [E('Angie@X.com', 'all'), U('angie@x.com', '["Moving"]')],
      'Moving', 'move',
    )
    expect(out).toHaveLength(1)
    expect(out[0].source).toBe('user')
  })
  it('a genuine external with no hub_user twin is untouched', () => {
    const out = filterRecipientsByProjectType(
      [U('owner@x.com', '["Moving"]'), E('outside@x.com', 'all')],
      'Moving', 'move',
    ).map(r => r.email).sort()
    expect(out).toEqual(['outside@x.com', 'owner@x.com'])
  })
})

// ── resolveLeadRecipients: toggle gating (integration via mock) ──────────────
function seed(splitEnabled: boolean) {
  tableData.current = {
    hub_users: [
      { id: 'u-owner', full_name: 'Olivia', first_name: 'Olivia', last_name: 'O', email: 'olivia@x.com', role: 'owner', location_id: 'loc1' },
      { id: 'u-mgr', full_name: 'Manny', first_name: 'Manny', last_name: 'M', email: 'manny@x.com', role: 'manager', location_id: 'loc1' },
    ],
    lead_notification_prefs: [
      { location_id: 'loc1', hub_user_id: 'u-owner', category: '["Moving"]', subscribed: true },
      // u-mgr has no row → default all/subscribed
    ],
    lead_notification_externals: [
      { id: 'e1', location_id: 'loc1', first_name: 'Ext', last_name: 'One', email: 'ext@x.com', phone: null, category: 'all', created_at: '2026-01-01' },
    ],
    locations: [
      { id: 'loc1', location_id: 'loc_slug', split_notifications_enabled: splitEnabled },
    ],
    lookups: [
      { category: 'project_types', label: 'Moving', is_active: true, attrs: { drip_category: 'move' }, sort_order: 1 },
      { category: 'project_types', label: 'Closet', is_active: true, attrs: { drip_category: 'general' }, sort_order: 2 },
    ],
  }
}
beforeEach(() => vi.clearAllMocks())

describe('resolveLeadRecipients — split toggle gating', () => {
  it('split OFF → every subscribed recipient (project type ignored)', async () => {
    seed(false)
    const eff = await resolveLeadRecipients('loc1', { project_type: 'Closet' })
    expect(eff.map(r => r.email).sort()).toEqual(['ext@x.com', 'manny@x.com', 'olivia@x.com'])
  })
  it('no lead passed → unchanged base behavior even if split ON', async () => {
    seed(true)
    const eff = await resolveLeadRecipients('loc1')
    expect(eff.map(r => r.email).sort()).toEqual(['ext@x.com', 'manny@x.com', 'olivia@x.com'])
  })
  it('split ON + Moving lead → owner (claimed Moving) + all-leads recipients; NOT the whole team', async () => {
    seed(true)
    const eff = await resolveLeadRecipients('loc1', { project_type: 'Moving' })
    // owner claims Moving; manny(all) + ext(all) are cross-cutting. Moving is
    // claimed → whole team is NOT pulled in beyond the all-leads matches.
    expect(eff.map(r => r.email).sort()).toEqual(['ext@x.com', 'manny@x.com', 'olivia@x.com'])
  })
  it('split ON + Closet lead (unclaimed) → everything-else → whole team + all-leads externals', async () => {
    seed(true)
    const eff = await resolveLeadRecipients('loc1', { project_type: 'Closet' })
    // Closet claimed by nobody → whole team (olivia, manny) + ext(all).
    expect(eff.map(r => r.email).sort()).toEqual(['ext@x.com', 'manny@x.com', 'olivia@x.com'])
  })
  it('split ON, owner-only claim, unmatched lead → never-drop to whole team', async () => {
    seed(true)
    // Make manny specific too so no one is 'all' among users; ext stays all.
    tableData.current.lead_notification_prefs = [
      { location_id: 'loc1', hub_user_id: 'u-owner', category: '["Moving"]', subscribed: true },
      { location_id: 'loc1', hub_user_id: 'u-mgr', category: '["Moving"]', subscribed: true },
    ]
    tableData.current.lead_notification_externals = []
    const eff = await resolveLeadRecipients('loc1', { project_type: 'Closet' })
    // Closet unclaimed → whole team (both users).
    expect(eff.map(r => r.email).sort()).toEqual(['manny@x.com', 'olivia@x.com'])
  })
  it('split ON + duplicated owner: one entry, hub_user wins, claim survives', async () => {
    seed(true)
    // Olivia (owner, claims Moving) also exists as a seeded external twin —
    // different casing, category 'all', exactly what the top-up wrote.
    tableData.current.lead_notification_externals.push({
      id: 'e-twin', location_id: 'loc1', first_name: 'Olivia', last_name: 'O',
      email: 'OLIVIA@x.com', phone: null, category: 'all', created_at: '2026-07-19',
    })
    const eff = await resolveLeadRecipients('loc1', { project_type: 'Moving' })
    const olivias = eff.filter(r => r.email.toLowerCase() === 'olivia@x.com')
    expect(olivias).toHaveLength(1)
    expect(olivias[0].source).toBe('user')
    expect(olivias[0].hub_user_id).toBe('u-owner')
    expect(olivias[0].category).toBe('["Moving"]')
  })
  it("split ON + duplicated owner: the twin does not leak them into another claimant's type", async () => {
    seed(true)
    tableData.current.lead_notification_prefs = [
      { location_id: 'loc1', hub_user_id: 'u-owner', category: '["Moving"]', subscribed: true },
      { location_id: 'loc1', hub_user_id: 'u-mgr', category: '["Closet"]', subscribed: true },
    ]
    tableData.current.lead_notification_externals = [
      { id: 'e-twin', location_id: 'loc1', first_name: 'Olivia', last_name: 'O',
        email: 'olivia@x.com', phone: null, category: 'all', created_at: '2026-07-19' },
    ]
    const eff = await resolveLeadRecipients('loc1', { project_type: 'Closet' })
    // Closet is Manny's claim. Olivia's 'all' twin must not pull her back in.
    expect(eff.map(r => r.email)).toEqual(['manny@x.com'])
  })
  it('legacy moving row still resolves under split ON', async () => {
    seed(true)
    tableData.current.lead_notification_prefs = [
      { location_id: 'loc1', hub_user_id: 'u-owner', category: 'moving', subscribed: true },
      { location_id: 'loc1', hub_user_id: 'u-mgr', category: '["Closet"]', subscribed: true },
    ]
    tableData.current.lead_notification_externals = []
    const eff = await resolveLeadRecipients('loc1', { project_type: 'Moving' })
    // Moving lead: owner(legacy moving) matches on drip 'move'. Closet-only mgr
    // excluded. Moving is not "claimed" by a specific type-set (legacy isn't
    // specific), so everything-else pulls in the whole team too.
    expect(eff.map(r => r.email).sort()).toEqual(['manny@x.com', 'olivia@x.com'])
  })
})

// ── Externals are never senders ─────────────────────────────────────────────
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
describe('externals are notify-only, never senders', () => {
  it('the sender pool is hub_users owner/manager — externals table is not consulted', () => {
    const senders = read('lib/project-type-senders.ts')
    expect(senders).toContain("SENDER_PICKABLE_ROLES = ['owner', 'manager']")
    expect(senders).not.toContain('lead_notification_externals')
  })
})

// ── Migration + route wiring (source sweep) ─────────────────────────────────
describe('migration + routes', () => {
  const mig = read('migrations/split_notifications_enabled.sql')
  const mainRoute = read('app/api/locations/[id]/notification-recipients/route.ts')

  it('STOP-gated migration adds the toggle and widens the category checks', () => {
    expect(mig).toContain('add column if not exists split_notifications_enabled boolean not null default false')
    expect(mig).toContain('drop constraint if exists lead_notification_prefs_category_check')
    expect(mig).toContain('drop constraint if exists lead_notification_externals_category_check')
    expect(mig).toContain('NOT YET APPLIED')
  })
  it('the route accepts the split_enabled flip and a JSON-array category', () => {
    expect(mainRoute).toContain("typeof body.split_enabled === 'boolean'")
    expect(mainRoute).toContain('setSplitNotificationsEnabled')
    expect(mainRoute).toContain('isValidCategoryField')
    expect(mainRoute).toContain('getNotificationConfig')
  })
})
