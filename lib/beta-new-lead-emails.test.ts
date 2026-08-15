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


// ── Cross-table twin collapse ───────────────────────────────────────────────
// The Zoho seed/top-up put owner emails into lead_notification_externals that
// also belong to a hub_user at the location (39 rows in prod, 2026-07-19). The
// twin arrives with category 'all', so left in the array it matches every lead
// — the person could never be routed away from anything. One person, one
// entry: hub_user wins, their configured claim survives.

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
  it('the route no longer offers a split_enabled flip, and still validates category', () => {
    // issue 246 step 2 — the flag is retired, so the PATCH branch that flipped
    // it is gone. `category` validation stays: the column still exists and the
    // legacy values still have to round-trip until the Part 3 cleanup.
    expect(mainRoute).not.toContain("typeof body.split_enabled === 'boolean'")
    expect(mainRoute).not.toContain('setSplitNotificationsEnabled')
    expect(mainRoute).toContain('isValidCategoryField')
    expect(mainRoute).toContain('getNotificationConfig')
    // And the new field is carried through the add path — the drop point that
    // would otherwise 200-OK a `subscribed` into the void.
    expect(mainRoute).toContain('subscribed')
  })
})
