// Lead Notification Recipients — per-location manager for WHO gets emailed on a
// new client. Visible/editable to super_admin + franchise OWNER ONLY; a Hive
// MANAGER must NOT see or edit it (they receive lead emails, they don't manage
// the list) — gated in the UI section AND server-side on every API route.
// Interface users (hub_users) auto-included by default (no row = subscribed/
// 'all'); externals stored directly; resolver returns subscribed users +
// externals and excludes unsubscribed. Mirrors the owner-only financials gate.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── Mock supabaseService: honors .eq()/.in() so location + role filtering
//    (and location isolation) behave like the real query. ─────────────────
const tableData = vi.hoisted(() => ({ current: {} as Record<string, any[]> }))
vi.mock('@/lib/supabase-service', () => {
  const makeBuilder = (table: string) => {
    const filters: any[] = []
    const b: any = {}
    b.select = () => b
    b.order = () => b
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

// ── Mock the Zoho client so the non-interface fallback is deterministic and
//    the network is never touched. ──────────────────────────────────────────
const zohoContacts = vi.hoisted(() => ({
  bySlug: {} as Record<string, any[]>,
  fail: null as string | null,
}))
vi.mock('@/lib/zoho', () => ({
  getZohoLocationNotificationContacts: vi.fn(async (slug: string) => {
    if (zohoContacts.fail) throw new Error(zohoContacts.fail)
    return zohoContacts.bySlug[slug] || []
  }),
}))
import { getZohoLocationNotificationContacts } from '@/lib/zoho'

import {
  notificationRecipientsManageable,
  notificationRecipientsManageableServer,
} from '@/lib/notification-access'
import {
  getManageableRecipients,
  resolveLeadRecipients,
  DEFAULT_CATEGORY,
  RECIPIENT_CATEGORIES,
} from '@/lib/notification-recipients'

// ── Permission predicates ──────────────────────────────────────────────────
describe('notificationRecipientsManageable — CLIENT gate (UI show/hide)', () => {
  it('super_admin + corporate can manage (any location)', () => {
    expect(notificationRecipientsManageable('super_admin', 'owner')).toBe(true)
    expect(notificationRecipientsManageable('corporate', 'owner')).toBe(true)
    expect(notificationRecipientsManageable('super_admin', 'manager')).toBe(true)
  })
  it('franchise OWNER can manage', () => {
    expect(notificationRecipientsManageable('franchise', 'owner')).toBe(true)
  })
  it('franchise MANAGER cannot manage', () => {
    expect(notificationRecipientsManageable('franchise', 'manager')).toBe(false)
  })
  it('lite/viewer and unknown roles cannot manage', () => {
    expect(notificationRecipientsManageable('franchise', 'viewer')).toBe(false)
    expect(notificationRecipientsManageable('franchise', 'readonly')).toBe(false)
    expect(notificationRecipientsManageable(undefined, undefined)).toBe(false)
    expect(notificationRecipientsManageable(null, null)).toBe(false)
  })
})

describe('notificationRecipientsManageableServer — SERVER gate (raw DB role)', () => {
  it('elevated may manage any location', () => {
    expect(notificationRecipientsManageableServer('super_admin', 'locX', 'loc1')).toBe(true)
    expect(notificationRecipientsManageableServer('admin', null, 'loc1')).toBe(true)
  })
  it('owner may manage ONLY their own location', () => {
    expect(notificationRecipientsManageableServer('owner', 'loc1', 'loc1')).toBe(true)
    expect(notificationRecipientsManageableServer('owner', 'loc2', 'loc1')).toBe(false)
    expect(notificationRecipientsManageableServer('owner', null, 'loc1')).toBe(false)
  })
  it('MANAGER is denied even at their own location (direct API hit)', () => {
    expect(notificationRecipientsManageableServer('manager', 'loc1', 'loc1')).toBe(false)
  })
  it('lite_user is denied', () => {
    expect(notificationRecipientsManageableServer('lite_user', 'loc1', 'loc1')).toBe(false)
  })
})

// ── Resolver + manageable list ──────────────────────────────────────────────
function seed() {
  tableData.current = {
    hub_users: [
      { id: 'u-owner', full_name: 'Olivia Owner', first_name: 'Olivia', last_name: 'Owner', email: 'olivia@x.com', role: 'owner', location_id: 'loc1' },
      { id: 'u-mgr', full_name: 'Manny Manager', first_name: 'Manny', last_name: 'Manager', email: 'manny@x.com', role: 'manager', location_id: 'loc1' },
      { id: 'u-fired', full_name: 'Fired Fred', first_name: 'Fired', last_name: 'Fred', email: 'fred@x.com', role: 'manager', location_id: 'loc1' },
      { id: 'u-lite', full_name: 'Larry Lite', first_name: 'Larry', last_name: 'Lite', email: 'larry@x.com', role: 'lite_user', location_id: 'loc1' },
      { id: 'u-other', full_name: 'Otto Other', first_name: 'Otto', last_name: 'Other', email: 'otto@x.com', role: 'owner', location_id: 'loc2' },
    ],
    lead_notification_prefs: [
      { location_id: 'loc1', hub_user_id: 'u-mgr', category: 'moving', subscribed: true },
      { location_id: 'loc1', hub_user_id: 'u-fired', category: 'all', subscribed: false },
      { location_id: 'loc2', hub_user_id: 'u-other', category: 'organizing', subscribed: true },
    ],
    lead_notification_externals: [
      { id: 'e1', location_id: 'loc1', first_name: 'Ext', last_name: 'One', email: 'ext1@x.com', phone: '555-1', category: 'organizing', created_at: '2026-01-01' },
      { id: 'e2', location_id: 'loc2', first_name: 'Ext', last_name: 'Two', email: 'ext2@x.com', phone: null, category: 'all', created_at: '2026-01-01' },
    ],
    // Supabase UUID → Zoho Location_ID slug, for the Zoho fallback path.
    // loc-zoho is a NON-interface location (no hub_users seeded for it).
    // Slug + contacts below are SYNTHETIC fixtures, not live CRM data.
    locations: [
      { id: 'loc-zoho', location_id: 'loc_zslug' },
      { id: 'loc-nomap', location_id: null },
    ],
  }
  // SYNTHETIC fixtures — not live CRM data. The deliverable recipient uses the
  // controlled admin@beeorganized.com address; the opted-out row uses a
  // reserved example.com address (RFC 2606) so the exclusion is observable.
  zohoContacts.bySlug = {
    loc_zslug: [
      { name: 'Admin Recipient', email: 'admin@beeorganized.com', opted_out: false },
      { name: 'Opted Out', email: 'optout@example.com', opted_out: true },
    ],
  }
  zohoContacts.fail = null
}
beforeEach(() => {
  seed()
  vi.clearAllMocks()
})

describe('getManageableRecipients — merged list for the owner UI', () => {
  it('auto-lists interface users (owner+manager); owner with no row defaults to All/subscribed', async () => {
    const { users } = await getManageableRecipients('loc1')
    const owner = users.find(u => u.hub_user_id === 'u-owner')!
    expect(owner).toBeTruthy()
    expect(owner.category).toBe('all')       // DEFAULT — no row needed
    expect(owner.subscribed).toBe(true)
    // reads name/email LIVE from hub_users (not copied)
    expect(owner.name).toBe('Olivia Owner')
    expect(owner.email).toBe('olivia@x.com')
  })
  it('applies a saved category and reflects an unsubscribe', async () => {
    const { users } = await getManageableRecipients('loc1')
    expect(users.find(u => u.hub_user_id === 'u-mgr')!.category).toBe('moving')
    const fired = users.find(u => u.hub_user_id === 'u-fired')!
    expect(fired.subscribed).toBe(false)      // terminated manager, notifications off
  })
  it('excludes lite_user and other-location users from the interface list', async () => {
    const { users } = await getManageableRecipients('loc1')
    expect(users.some(u => u.hub_user_id === 'u-lite')).toBe(false)
    expect(users.some(u => u.hub_user_id === 'u-other')).toBe(false)
  })
  it('location-scoped externals only', async () => {
    const { externals } = await getManageableRecipients('loc1')
    expect(externals.map(e => e.id)).toEqual(['e1'])
    expect(externals[0].category).toBe('organizing')
    expect(externals[0].phone).toBe('555-1')
  })
})

describe('resolveLeadRecipients — effective SEND list (B2)', () => {
  it('returns subscribed users + externals, excludes the unsubscribed', async () => {
    const eff = await resolveLeadRecipients('loc1')
    const emails = eff.map(r => r.email).sort()
    expect(emails).toEqual(['ext1@x.com', 'manny@x.com', 'olivia@x.com'])
    expect(emails).not.toContain('fred@x.com')   // unsubscribed excluded
  })
  it('carries the category and marks the source', async () => {
    const eff = await resolveLeadRecipients('loc1')
    const owner = eff.find(r => r.email === 'olivia@x.com')!
    expect(owner.source).toBe('user')
    expect(owner.category).toBe('all')
    const ext = eff.find(r => r.email === 'ext1@x.com')!
    expect(ext.source).toBe('external')
    expect(ext.category).toBe('organizing')
  })
  it('is location-isolated (loc2 data never leaks into loc1)', async () => {
    const eff = await resolveLeadRecipients('loc1')
    expect(eff.some(r => r.email === 'otto@x.com')).toBe(false)
    expect(eff.some(r => r.email === 'ext2@x.com')).toBe(false)
  })
  it('a location with no prefs/externals still auto-includes its users at defaults', async () => {
    tableData.current.lead_notification_prefs = []
    tableData.current.lead_notification_externals = []
    const eff = await resolveLeadRecipients('loc1')
    // owner + 2 managers, all default subscribed/all
    expect(eff.map(r => r.email).sort()).toEqual(['fred@x.com', 'manny@x.com', 'olivia@x.com'])
    expect(eff.every(r => r.category === 'all')).toBe(true)
  })
})

// ── B3: Zoho fallback for non-interface locations ───────────────────────────
describe('resolveLeadRecipients — Zoho fallback (B3)', () => {
  it('a location WITH interface recipients uses those; Zoho is NOT called', async () => {
    const eff = await resolveLeadRecipients('loc1')
    expect(eff.map(r => r.email).sort()).toEqual(['ext1@x.com', 'manny@x.com', 'olivia@x.com'])
    expect(getZohoLocationNotificationContacts).not.toHaveBeenCalled()
    expect(eff.every(r => r.source !== 'zoho')).toBe(true)
  })

  it('an interface location with EVERYONE unsubscribed and no externals stays interface (empty), does NOT fall back to Zoho', async () => {
    // loc1: unsubscribe every user, drop externals → still interface-managed.
    tableData.current.lead_notification_prefs = [
      { location_id: 'loc1', hub_user_id: 'u-owner', category: 'all', subscribed: false },
      { location_id: 'loc1', hub_user_id: 'u-mgr', category: 'all', subscribed: false },
      { location_id: 'loc1', hub_user_id: 'u-fired', category: 'all', subscribed: false },
    ]
    tableData.current.lead_notification_externals = []
    const eff = await resolveLeadRecipients('loc1')
    expect(eff).toEqual([])
    expect(getZohoLocationNotificationContacts).not.toHaveBeenCalled()
  })

  it('a location WITHOUT interface recipients resolves from Zoho (excluding opted-out)', async () => {
    const eff = await resolveLeadRecipients('loc-zoho')
    expect(getZohoLocationNotificationContacts).toHaveBeenCalledWith('loc_zslug')
    expect(eff.map(r => r.email).sort()).toEqual(['admin@beeorganized.com'])
    expect(eff.some(r => r.email === 'optout@example.com')).toBe(false) // opted out
    expect(eff.every(r => r.source === 'zoho' && r.category === 'all' && r.hub_user_id === null)).toBe(true)
  })

  it('a Zoho FAILURE logs loudly with the location id and does not throw or silently drop', async () => {
    zohoContacts.fail = 'zoho 500'
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const eff = await resolveLeadRecipients('loc-zoho')
    expect(eff).toEqual([])
    expect(err).toHaveBeenCalled()
    const msg = err.mock.calls.map(c => String(c[0])).join('\n')
    expect(msg).toContain('loc-zoho')
    expect(msg).toContain('FAILED')
    err.mockRestore()
  })

  it('a non-interface location that resolves to ZERO recipients logs loudly (never silent)', async () => {
    zohoContacts.bySlug = { loc_zslug: [] } // no contacts in Zoho
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const eff = await resolveLeadRecipients('loc-zoho')
    expect(eff).toEqual([])
    expect(err.mock.calls.map(c => String(c[0])).join('\n')).toContain('ZERO')
    err.mockRestore()
  })

  it('a non-interface location with no Zoho Location_ID mapping logs loudly and returns []', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const eff = await resolveLeadRecipients('loc-nomap')
    expect(eff).toEqual([])
    expect(getZohoLocationNotificationContacts).not.toHaveBeenCalled()
    expect(err.mock.calls.map(c => String(c[0])).join('\n')).toContain('loc-nomap')
    err.mockRestore()
  })
})

describe('category constants', () => {
  it('All is default; three options', () => {
    expect(DEFAULT_CATEGORY).toBe('all')
    expect([...RECIPIENT_CATEGORIES]).toEqual(['all', 'moving', 'organizing'])
  })
})

// ── Source wiring: UI placement + gating, API server-side enforcement ───────
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const beehub = read('components/BeeHub.jsx')
const mainRoute = read('app/api/locations/[id]/notification-recipients/route.ts')
const extRoute = read('app/api/locations/[id]/notification-recipients/externals/[extId]/route.ts')

const slice = (src: string, from: string, to: string) => {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a + 1)
  return a >= 0 && b >= 0 ? src.slice(a, b) : ''
}

describe('UI — placement in the owner+super_admin-only Communication tab', () => {
  const comp = slice(beehub, 'function NewLeadNotifications(', '// ─── SMS Add-on Card')

  it('renders in the Communication tab, wired to the real location UUID', () => {
    expect(beehub).toContain('<NewLeadNotifications realLocId={realLocId}')
  })
  it('lives under the composed "Who hears about new leads" tier alongside the sending-identity hero', () => {
    // The unified new-lead emails block moved out of My Location into the
    // Communication tab (activeSection==='paths'), composed in tiers.
    expect(beehub).toContain('Who hears about new leads')
    expect(beehub).toContain('Sending identity')
  })
  it('the Communication tab is HIDDEN from managers (isManager excluded)', () => {
    // Both the tab list and the notifications live behind the same non-manager
    // gate → owner + super_admin/corporate only.
    expect(beehub).toContain("label:'Communication'")
    expect(beehub).toContain("const isManager = franchiseRole === 'manager'")
  })
  it('the placeholder card is gone (no competing notifications UI)', () => {
    expect(beehub).not.toContain('function LeadNotificationsCard(')
    // the old single-category component + select are fully replaced
    expect(beehub).not.toContain('function LeadNotificationRecipients(')
    expect(beehub).not.toContain('function LeadNotifCategorySelect(')
  })
  it('readOnly hides every editable control', () => {
    expect(comp).toContain('function NewLeadNotifications({ realLocId, readOnly')
    // subscribe/remove + add form are all behind !readOnly / readOnly ?
    expect(comp).toContain('readOnly ?')
    expect(comp).toContain('{!readOnly && (adding')
  })
  it('the basic recipient list + subscribe/remove works with the toggle OFF', () => {
    // Team subscribe/remove and the outside-email add are NOT gated on advanced.
    expect(comp).toContain('patchUser(u.hub_user_id, { subscribed: !u.subscribed })')
    expect(comp).toContain('+ Add outside email')
    expect(comp).toContain('LEAD_NOTIF_EMAIL_RE.test(email)')
  })
  it('the per-part advanced toggle persists split_enabled', () => {
    expect(comp).toContain('Notify different people by project type')
    expect(comp).toContain("JSON.stringify({ split_enabled: on })")
  })
  it('advanced shows per-recipient project-type pills + the everything-else row', () => {
    expect(comp).toContain('RecipientTypePicker')
    expect(comp).toContain('Everything else → whole team')
  })
})

describe('API — every verb gated server-side to owner + elevated', () => {
  it('main route imports the server predicate and gates GET/PATCH/POST', () => {
    expect(mainRoute).toContain('notificationRecipientsManageableServer')
    expect(mainRoute).toContain('export async function GET')
    expect(mainRoute).toContain('export async function PATCH')
    expect(mainRoute).toContain('export async function POST')
    // authForLocation is invoked at the top of each handler (>= 3 times)
    expect((mainRoute.match(/await authForLocation/g) || []).length).toBeGreaterThanOrEqual(3)
    expect(mainRoute).toContain("error: 'forbidden'")
  })
  it('main route rejects a pref write for a user outside the location', () => {
    expect(mainRoute).toContain('user not at this location')
  })
  it('externals route gates PATCH + DELETE with the same predicate', () => {
    expect(extRoute).toContain('notificationRecipientsManageableServer')
    expect(extRoute).toContain('export async function PATCH')
    expect(extRoute).toContain('export async function DELETE')
    expect((extRoute.match(/await authForLocation/g) || []).length).toBeGreaterThanOrEqual(2)
    // external must belong to the location in the path
    expect(extRoute).toContain('loadExternalAtLocation')
  })
})

describe('API — duplicate-recipient prevention (the structural-hole fix)', () => {
  // Scope to the POST handler only — the PATCH handler above it legitimately
  // upserts lead_notification_prefs onConflict (location_id,hub_user_id), which
  // is unrelated to the externals uniqueness this block asserts.
  const postFn = mainRoute.slice(mainRoute.indexOf('export async function POST'))

  it('POST normalizes email to lowercase before storing', () => {
    // Stored value == the (location_id, email) uniqueness key, so a re-cased
    // add can never create a second row.
    expect(postFn).toContain('.trim().toLowerCase()')
  })
  it('POST dedups application-side (idempotent add), returning the existing row', () => {
    // Existence check on (location_id, email) BEFORE the insert — the guard that
    // works even BEFORE the unique-index migration runs.
    expect(postFn).toContain(".eq('location_id', params.id)")
    expect(postFn).toContain(".eq('email', email)")
    expect(postFn).toContain('duplicate: true')
  })
  it('POST does NOT use ON CONFLICT / upsert — it ships ahead of the index', () => {
    // An ON CONFLICT naming a not-yet-existing unique index is a 42P10 in the
    // pre-migration window. Deliberately avoided; the DB index is a pure backstop.
    expect(postFn).not.toContain('onConflict')
    expect(postFn).not.toContain('.upsert(')
  })
  it('POST treats the unique backstop (23505) as benign, not a 500', () => {
    expect(postFn).toContain("'23505'")
  })
  it('externals PATCH lowercases the edited email and 409s on a collision', () => {
    expect(extRoute).toContain('.trim().toLowerCase()')
    expect(extRoute).toContain("'23505'")
    expect(extRoute).toContain('duplicate_recipient')
  })
})
