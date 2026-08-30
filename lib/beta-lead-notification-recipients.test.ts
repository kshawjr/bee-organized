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
    let limitN: number | null = null
    const b: any = {}
    b.select = () => b
    b.order = () => b
    b.eq = (col: string, val: any) => { filters.push(['eq', col, val]); return b }
    b.in = (col: string, vals: any[]) => { filters.push(['in', col, vals]); return b }
    // .is(col, null) — used by locationHasActiveHubUser for `disabled_at IS NULL`.
    b.is = (col: string, val: any) => { filters.push(['is', col, val]); return b }
    // .not(col,'is',null) + .maybeSingle() — used by the owner-resolution chain,
    // reached since the assignee-always-told rule (2026-08-30) whenever a
    // location has someone switched off.
    b.not = (col: string, _op: string, val: any) => { filters.push(['not', col, val]); return b }
    b.limit = (n: number) => { limitN = n; return b }
    const resolve = () => {
      let data = tableData.current[table] || []
      for (const [op, col, val] of filters) {
        data = op === 'in'
          ? data.filter((r: any) => val.includes(r[col]))
          : op === 'not'
            ? data.filter((r: any) => (r[col] ?? null) !== val)
            : data.filter((r: any) => r[col] === val)
      }
      if (limitN != null) data = data.slice(0, limitN)
      return { data, error: null }
    }
    b.maybeSingle = () => Promise.resolve({ data: resolve().data[0] ?? null, error: null })
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
  locationHasActiveHubUser,
  DEFAULT_CATEGORY,
  RECIPIENT_CATEGORIES,
} from '@/lib/notification-recipients'
import { supabaseService } from '@/lib/supabase-service'

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

// ── External twins of interface users are suppressed at the send list ───────
// Externals carry no subscribe flag, so a seeded twin of a hub_user would keep
// that person on the send list after they unsubscribe or lose access. The
// resolver drops any external whose address matches an interface user at the
// location — the user's pref governs. lite_user addresses never match (they
// are not interface users), so their external rows keep working.
describe('resolveLeadRecipients — external twin suppression', () => {
  it('an UNSUBSCRIBED user\'s external twin does not resurrect them (case-insensitive)', async () => {
    // fred is unsubscribed; his seeded twin arrives with different casing.
    tableData.current.lead_notification_externals.push(
      { id: 'e-twin', location_id: 'loc1', first_name: 'Fired', last_name: 'Fred', email: 'FRED@X.com', phone: null, category: 'all', created_at: '2026-07-19' },
    )
    const eff = await resolveLeadRecipients('loc1')
    expect(eff.some(r => r.email.toLowerCase() === 'fred@x.com')).toBe(false)
  })
  it('a SUBSCRIBED user\'s twin collapses to the single user entry (their configured category wins)', async () => {
    tableData.current.lead_notification_externals.push(
      { id: 'e-twin2', location_id: 'loc1', first_name: null, last_name: null, email: 'manny@x.com', phone: null, category: 'all', created_at: '2026-07-19' },
    )
    const eff = await resolveLeadRecipients('loc1')
    const manny = eff.filter(r => r.email === 'manny@x.com')
    expect(manny).toHaveLength(1)
    expect(manny[0].source).toBe('user')
    expect(manny[0].category).toBe('moving') // the pref, not the seeded 'all'
  })
  it("a lite_user's external row is NOT suppressed — it is what notifies them", async () => {
    tableData.current.lead_notification_externals.push(
      { id: 'e-lite', location_id: 'loc1', first_name: 'Larry', last_name: 'Lite', email: 'larry@x.com', phone: null, category: 'all', created_at: '2026-07-19' },
    )
    const eff = await resolveLeadRecipients('loc1')
    const larry = eff.find(r => r.email === 'larry@x.com')!
    expect(larry).toBeTruthy()
    expect(larry.source).toBe('external')
  })
  it('the management UI list still SHOWS the twin (suppression is send-time only)', async () => {
    tableData.current.lead_notification_externals.push(
      { id: 'e-twin3', location_id: 'loc1', first_name: null, last_name: null, email: 'olivia@x.com', phone: null, category: 'all', created_at: '2026-07-19' },
    )
    const { externals } = await getManageableRecipients('loc1')
    expect(externals.some(e => e.id === 'e-twin3')).toBe(true)
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

  it('an interface location with EVERYONE unsubscribed stays interface — the ASSIGNEE alone is emailed, Zoho is NOT consulted', async () => {
    // REVERSED 2026-08-30 (assignee-always-told): this used to pin `eff ===
    // []` — "the owner turned everyone off" silenced the location entirely,
    // including the person each lead is assigned to. All-off now means the
    // broadcast is off but a lead still reaches its assignee (here the owner:
    // no handler rows at loc1). The Zoho half of the old pin stands untouched.
    tableData.current.lead_notification_prefs = [
      { location_id: 'loc1', hub_user_id: 'u-owner', category: 'all', subscribed: false },
      { location_id: 'loc1', hub_user_id: 'u-mgr', category: 'all', subscribed: false },
      { location_id: 'loc1', hub_user_id: 'u-fired', category: 'all', subscribed: false },
    ]
    tableData.current.lead_notification_externals = []
    const eff = await resolveLeadRecipients('loc1')
    expect(eff.map(r => r.email)).toEqual(['olivia@x.com'])
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
  // End-marker was '// ─── SMS Add-on Card', which issue 240 step 1 deleted
  // along with SmsAddonCard itself (defined, never mounted, unreachable
  // behind a location flag nothing populated). Re-anchored to the next
  // top-level declaration after this component. A missing marker makes slice
  // return '' and every assertion below fails loudly — which is how this
  // re-anchor got caught, so leave that behaviour alone.
  // issue 246 step 2 — NewLeadNotifications and TeamRouting were replaced by a
  // single NewLeadsSection: two independent lists (who HANDLES a job type, who
  // is TOLD about a lead) where there used to be one fused `category` field.
  const comp = slice(beehub, 'export function NewLeadsSection(', 'function fmtCents(')

  it('renders in the Communication tab, wired to the real location UUID', () => {
    expect(beehub).toContain('<NewLeadsSection realLocId={realLocId}')
  })
  it('carries BOTH of its tiers, and they are inside the component', () => {
    // WAS: expect(beehub).toContain('Who hears about new leads'), a raw
    // whole-file grep for the tier name this section used to sit under.
    //
    // That card was retired in issue 246 step 2 — NewLeadsSection replaced it
    // with two independent tiers — so the assertion should have failed then.
    // It did not: a COMMENT on the Emails tab still quoted "Who hears about new
    // leads" in prose, and a whole-file toContain cannot tell rendered UI from
    // a comment about UI. It passed on the comment for two commits, and only
    // failed when issue 246 step 3 deleted that comment along with the orphaned
    // sender toggle it described.
    //
    // Now asserted against `comp` — the NewLeadsSection slice — so a label has
    // to be IN the component, not merely somewhere in a 36k-line file.
    expect(comp).toContain('Who handles what')
    expect(comp).toContain('Who is told about a new lead')
    // And the string it used to grep for is genuinely gone, comment included.
    expect(beehub).not.toContain('Who hears about new leads')
  })

  it('the sending identity stayed on Emails and did not follow this section', () => {
    // Issue 246 step 1 split them: identity → Emails, routing + notification →
    // New leads. Pinned because they read as one feature and a later tidy-up
    // could plausibly re-merge them.
    //
    // Anchored on the three location rows rather than the old 'Sending identity'
    // heading, which issue 303 replaced: the card now leads with what the shown
    // sequence sends as, and those rows ARE the location identity wherever it is
    // headed. A heading is copy and copy moves; the rows are the feature.
    expect(beehub).toContain('label="Send From Name"')
    expect(comp).not.toContain('Send From Name')
    // And the reverse direction, which is the half that would actually hurt:
    // Emails must not grow the per-type editors that New leads owns.
    expect(comp).toContain('What it sends as')
  })
  it('the tab hosting this component is OWNER-allowlisted (hidden from manager AND lite_user)', () => {
    // The section list is an allowlist on franchiseRole==='owner' — the old
    // manager DENYLIST silently showed Communication to lite_user
    // (franchiseRole 'viewer', a string the denylist never named). Behavior
    // is mount-pinned in lib/beta-settings-access.test.tsx; this pin just
    // keeps the tab behind the allowlist const.
    //
    // NewLeadNotifications moved from Communication to 'Your team' in issue
    // 240 step 4, and from there to Notifications › New leads in issue 246
    // step 1 (Your team split three ways and stopped existing). The allowlist
    // is what matters here, not the label, so pin the section it lives on now.
    expect(beehub).toContain("label:'New leads'")
    expect(beehub).toContain("const ownerConfig = franchiseRole === 'owner'")
  })
  it('the placeholder card is gone (no competing notifications UI)', () => {
    expect(beehub).not.toContain('function LeadNotificationsCard(')
    // the old single-category component + select are fully replaced
    expect(beehub).not.toContain('function LeadNotificationRecipients(')
    expect(beehub).not.toContain('function LeadNotifCategorySelect(')
  })
  it('readOnly hides every editable control', () => {
    expect(comp).toContain('export function NewLeadsSection({ realLocId, readOnly')
    expect(comp).toContain('readOnly ?')
    expect(comp).toContain('{!readOnly && (adding')
  })
  it('the recipient list carries subscribe + the outside-email add', () => {
    expect(comp).toContain('toggleUser(u)')
    expect(comp).toContain('+ Add outside email')
    expect(comp).toContain('LEAD_NOTIF_EMAIL_RE.test(email)')
  })
  it('there is NO advanced toggle — the split flag is retired', () => {
    // Both of these strings were the toggle that fused "who is told" to job
    // types. Behaviour is mount-pinned in lib/beta-new-leads-246b.test.tsx.
    expect(comp).not.toContain('Notify different people by project type')
    expect(comp).not.toContain('split_enabled')
  })
  it('who is told is a plain switch — no per-recipient project-type pills', () => {
    expect(comp).not.toContain('RecipientTypePicker')
    expect(comp).not.toContain('Everything else → whole team')
    // …and the switch writes `subscribed`, not a category.
    expect(comp).toContain('subscribed: next')
  })
  it('muting an outside address PATCHes rather than deleting it', () => {
    // The whole point of lead_notification_externals.subscribed: a DELETE
    // loses the record and the nightly Zoho top-up re-adds the address.
    expect(comp).toContain('toggleExternal')
    expect(comp).toContain("method:'PATCH'")
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

// ── #91: is this location ON Bee Hub? (locationHasActiveHubUser) ─────────────
// The location-scoped branch behind the two email variants. "Active" == the
// same definition access-removal and the global CC resolver use:
// is_active = true AND disabled_at IS NULL. ANY role counts (an active
// lite_user still means the office is on Bee Hub).
describe('locationHasActiveHubUser — #91 location Bee Hub branch', () => {
  const setHub = (rows: any[]) => {
    tableData.current.hub_users = rows
  }

  it('true when the location has an active hub_user (any role, incl. lite_user)', async () => {
    setHub([
      { id: 'u1', role: 'lite_user', location_id: 'locA', is_active: true, disabled_at: null },
    ])
    expect(await locationHasActiveHubUser('locA')).toBe(true)
  })

  it('false when the location has NO hub_users at all', async () => {
    setHub([
      { id: 'u1', role: 'owner', location_id: 'locB', is_active: true, disabled_at: null },
    ])
    expect(await locationHasActiveHubUser('locA')).toBe(false)
  })

  it('false when the only hub_user is is_active = false', async () => {
    setHub([
      { id: 'u1', role: 'owner', location_id: 'locA', is_active: false, disabled_at: null },
    ])
    expect(await locationHasActiveHubUser('locA')).toBe(false)
  })

  it('false when the only hub_user is disabled (disabled_at set)', async () => {
    setHub([
      { id: 'u1', role: 'owner', location_id: 'locA', is_active: true, disabled_at: '2026-07-01T00:00:00Z' },
    ])
    expect(await locationHasActiveHubUser('locA')).toBe(false)
  })

  it('ignores active users at OTHER locations (location-scoped)', async () => {
    setHub([
      { id: 'u1', role: 'owner', location_id: 'locA', is_active: false, disabled_at: null },
      { id: 'u2', role: 'owner', location_id: 'locOther', is_active: true, disabled_at: null },
    ])
    expect(await locationHasActiveHubUser('locA')).toBe(false)
  })

  it('fails SOFT to NO-access (false) when the read throws', async () => {
    // A lookup failure must NOT default to the Bee Hub email — that would send
    // the dead-button/"get set up" message this branch exists to prevent. The
    // resolver swallows and returns false; the caller sends the clean variant.
    const spy = vi
      .spyOn(supabaseService, 'from')
      .mockImplementationOnce(() => {
        throw new Error('hub_users read exploded')
      })
    expect(await locationHasActiveHubUser('locA')).toBe(false)
    spy.mockRestore()
  })
})
