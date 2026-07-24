// @vitest-environment node
//
// lead → Network conversion. The pins here are the decisions that would be
// expensive to get wrong and cheap to regress:
//
//   A) BAND — personBand narrowed: a specialty beats the customer signal, so
//      the realtor who also hires us stays in Real estate. "Potential
//      customers" keeps meaning "may hire us, direction unknown".
//   B) DEDUP GATE — exact email/phone, email outranks phone, name is NEVER a
//      key, no keys → no match (never a scan-and-guess).
//   C) FIELD MAPPING — stage seeded 'New Contact' (door #4), what carries,
//      and specifically what must NOT (lead stage, junk/paused/drip state,
//      the lead's own referrer).
//   D) FILL-EMPTY on a matched partner — the Network's curated values win,
//      and a legacy stage-less partner gets rescued into the pipeline.
//   E) INBOX SOFT-HIDE — the move patch is inbox_dismissed_at + paused, and
//      the lead-cols → person-fields map carries the dismissal so the row
//      drops live.
//   F) THE 'all' COUNT GAP — Home's transfer card filters the same way in
//      both branches (source pin: the two call sites are one expression).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { personBand, POTENTIAL_BAND, JUST_MET_BAND } from '@/components/hive/shared/networkGroups'
import {
  findPartnerForLead,
  leadToPartnerRow,
  fillEmptyPartnerPatch,
  NEW_PARTNER_STAGE,
} from '@/lib/lead-to-network'
import { leadColsToPersonFields } from '@/components/hive/shared/leadPatchMap'

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// ── A) the band rule ────────────────────────────────────────────────────────
describe('A) personBand — specialty beats the customer signal', () => {
  const P = (over: any) => ({ stage: '', tags: [], specialties: [], isCustomer: false, ...over })

  it('the Karen Pell case: a realtor who is ALSO a client bands as a realtor', () => {
    expect(personBand(P({ specialties: ['real-estate'], isCustomer: true }))).toBe('real-estate')
  })

  it('stage Customer and the warm tag lose to a specialty too', () => {
    expect(personBand(P({ specialties: ['contractor'], stage: 'Customer' }))).toBe('contractor')
    expect(personBand(P({ specialties: ['contractor'], tags: ['warm'] }))).toBe('contractor')
  })

  it('the customer signal still claims someone with NO specialty', () => {
    expect(personBand(P({ isCustomer: true }))).toBe(POTENTIAL_BAND)
    expect(personBand(P({ stage: 'Customer' }))).toBe(POTENTIAL_BAND)
    expect(personBand(P({ tags: ['warm'] }))).toBe(POTENTIAL_BAND)
  })

  it('no signal at all is still Just met', () => {
    expect(personBand(P({}))).toBe(JUST_MET_BAND)
  })

  it('the primary (FIRST) specialty is the band, not any later one', () => {
    expect(personBand(P({ specialties: ['stager', 'real-estate'], isCustomer: true }))).toBe('stager')
  })
})

// ── B) the dedup gate ───────────────────────────────────────────────────────
describe('B) findPartnerForLead — the authoritative match', () => {
  const rows = [
    { id: 'pt-1', name: 'Karen Martinez', email: 'KAREN@meridian.com', phone: '(561) 555-0199' },
    { id: 'pt-2', name: 'Sam Broker', email: 'sam@meridian.com', phone: '5615550100' },
    { id: 'pt-3', name: 'Karen Martinez', email: '', phone: '' },
  ]
  const svc = (data: any[] = rows) => ({
    from: () => {
      const b: any = {}
      for (const m of ['select', 'eq', 'is']) b[m] = () => b
      b.range = () => Promise.resolve({ data, error: null })
      return b
    },
  })

  it('matches email case-insensitively', async () => {
    const hit = await findPartnerForLead(svc(), { locationId: 'loc-1', email: 'karen@MERIDIAN.com' })
    expect(hit).toEqual({ partner: rows[0], matchedOn: 'email' })
  })

  it('matches phone on digits regardless of stored formatting', async () => {
    const hit = await findPartnerForLead(svc(), { locationId: 'loc-1', phone: '561-555-0199' })
    expect(hit?.partner.id).toBe('pt-1')
    expect(hit?.matchedOn).toBe('phone')
  })

  it('email outranks phone when they point at different rows', async () => {
    const hit = await findPartnerForLead(svc(), {
      locationId: 'loc-1', email: 'sam@meridian.com', phone: '5615550199',
    })
    expect(hit?.partner.id).toBe('pt-2')
    expect(hit?.matchedOn).toBe('email')
  })

  it('phone match is EXACT, not a substring — a shared 7-digit run is not a person', async () => {
    // '5550199' is contained in pt-1's digits; the as-you-type matcher would
    // hit, the authoritative gate must not.
    expect(await findPartnerForLead(svc(), { locationId: 'loc-1', phone: '5550199' })).toBeNull()
  })

  it('name is NEVER a match key — two Karen Martinezes are two people', async () => {
    expect(await findPartnerForLead(svc(), { locationId: 'loc-1', email: '', phone: '' })).toBeNull()
  })

  it('no usable key → null without querying at all', async () => {
    let queried = false
    const spy = { from: () => { queried = true; return {} as any } }
    expect(await findPartnerForLead(spy, { locationId: 'loc-1' })).toBeNull()
    expect(queried).toBe(false)
  })

  it('an empty stored email/phone never reads as a hit', async () => {
    const hit = await findPartnerForLead(svc([{ id: 'x', name: 'Blank', email: null, phone: null }]), {
      locationId: 'loc-1', email: 'someone@example.com', phone: '5615550000',
    })
    expect(hit).toBeNull()
  })
})

// ── C) the field mapping ────────────────────────────────────────────────────
describe('C) leadToPartnerRow', () => {
  const LEAD = {
    id: 'lead-1',
    name: 'Karen Pell',
    email: 'karen@meridian.com',
    phone: '(561) 555-0199',
    location_uuid: 'loc-uuid-1',
    address: '12 Oak St', city: 'Boca', state: 'FL', zip: '33432',
    addresses: [{ type: 'Home', value: '12 Oak St, Boca, FL 33432', street: '12 Oak St', city: 'Boca', state: 'FL', zip: '33432' }],
    source: 'Referral',
    request_details: 'Wants a pantry reset',
    created_at: '2025-11-04T15:00:00.000Z',
    // Every one of these must be DROPPED.
    stage: 'Attempting',
    project_type: 'Kitchen',
    is_junk: false,
    paused: true,
    drip_path: 'homeowner',
    jobber_client_id: 'jc-9',
    referred_by_kind: 'partner',
    referred_by_id: 'someone-else',
    inbox_dismissed_at: null,
    assigned_to: 'u-7',
  }

  it('seeds stage New Contact — door #4 matches the other three', () => {
    expect(leadToPartnerRow(LEAD).stage).toBe(NEW_PARTNER_STAGE)
    expect(NEW_PARTNER_STAGE).toBe('New Contact')
  })

  it('carries identity, location, address, provenance and the ask', () => {
    const row: any = leadToPartnerRow(LEAD, { specialties: ['real-estate'] })
    expect(row.name).toBe('Karen Pell')
    expect(row.email).toBe('karen@meridian.com')
    expect(row.phone).toBe('(561) 555-0199')
    expect(row.location_id).toBe('loc-uuid-1')   // location_uuid → location_id
    expect(row.specialties).toEqual(['real-estate'])
    expect(row.how_we_met).toBe('Referral')       // source → how_we_met
    expect(row.met_date).toBe('Nov 2025')         // free text, never a date
    expect(row.addresses[0]).toMatchObject({ type: 'Business', value: '12 Oak St, Boca, FL 33432', city: 'Boca' })
    expect(row.notes[0].text).toBe('Wants a pantry reset')
  })

  it('drops every lead-only field — pipeline stage, junk/paused/drip, Jobber, the lead OWN referrer', () => {
    const row: any = leadToPartnerRow(LEAD)
    for (const k of [
      'project_type', 'is_junk', 'paused', 'drip_path', 'jobber_client_id',
      'referred_by_kind', 'referred_by_id', 'inbox_dismissed_at', 'assigned_to',
    ]) expect(row).not.toHaveProperty(k)
    // stage EXISTS but is the partner vocabulary — never the lead's.
    expect(row.stage).not.toBe('Attempting')
  })

  it('falls back to first+last name, composes the flat address, and emits none when empty', () => {
    const row: any = leadToPartnerRow({
      first_name: 'Sam', last_name: 'Broker', location_uuid: 'loc-1',
      address: '9 Elm', city: 'Boca', state: 'FL', zip: '33432',
    })
    expect(row.name).toBe('Sam Broker')
    // Comma-joined exactly like NetworkAddSheet.composeAddresses — one
    // composer shape across the two doors, not a prettier one-off here.
    expect(row.addresses[0].value).toBe('9 Elm, Boca, FL, 33432')
    expect(leadToPartnerRow({ location_uuid: 'loc-1' } as any).addresses).toEqual([])
  })

  it('an unparseable created_at yields no met_date rather than a bogus one', () => {
    expect((leadToPartnerRow({ created_at: 'not-a-date' } as any) as any).met_date).toBe('')
    expect((leadToPartnerRow({} as any) as any).met_date).toBe('')
  })
})

// ── D) match-then-link ──────────────────────────────────────────────────────
describe('D) fillEmptyPartnerPatch — the Network keeps what it knows', () => {
  it('never overwrites a curated value', () => {
    const patch = fillEmptyPartnerPatch(
      { email: 'k@work.com', phone: '5610000000', stage: 'Active Partner', specialties: ['stager'] },
      { email: 'karen@home.com', phone: '5615550199' },
      ['real-estate']
    )
    expect(patch).toEqual({})
  })

  it('fills only the blanks', () => {
    const patch = fillEmptyPartnerPatch(
      { email: '', phone: null, stage: 'Building', specialties: ['stager'] },
      { email: 'karen@home.com', phone: '5615550199' },
      ['real-estate']
    )
    expect(patch).toEqual({ email: 'karen@home.com', phone: '5615550199' })
  })

  it('rescues a legacy stage-less partner back into the pipeline', () => {
    expect(fillEmptyPartnerPatch({ stage: '', email: 'a@b.c', phone: '1' }, {}, []).stage)
      .toBe(NEW_PARTNER_STAGE)
  })
})

// ── E) the move patch ───────────────────────────────────────────────────────
describe('E) Move — soft-hide, not junk', () => {
  const route = src('app/api/leads/[id]/network/route.ts')

  it('writes inbox_dismissed_at + paused, and never is_junk', () => {
    expect(route).toContain('leadPatch.inbox_dismissed_at')
    expect(route).toContain('leadPatch.paused = true')
    expect(route).not.toMatch(/is_junk\s*[:=]\s*true/)
  })

  it('drips are paused through the lifecycle module, not by hand', () => {
    expect(route).toContain('applyDripSideEffects')
  })

  it('add mode leaves the lead alone — no dismissal, no pause', () => {
    expect(route).toContain("if (mode === 'move') {")
  })

  it('the dismissal reaches people state so the Inbox row drops live', () => {
    expect(leadColsToPersonFields({ inbox_dismissed_at: '2026-07-23T00:00:00Z', paused: true }))
      .toEqual({ inboxDismissedAt: '2026-07-23T00:00:00Z', paused: true })
  })

  it('unknown columns are still dropped rather than guessed', () => {
    expect(leadColsToPersonFields({ some_new_col: 1 } as any)).toEqual({})
  })
})

// ── F) the Home count gap ───────────────────────────────────────────────────
describe('F) Home needs-transfer counts the same way in both scopes', () => {
  const hub = src('components/BeeHub.jsx')

  it('isLivePersonH is defined ONCE, above the all-locations early return', () => {
    const def = hub.indexOf('const isLivePersonH = (p) => !p.isJunk')
    const allBranch = hub.indexOf("if (allOverview) {", hub.indexOf('const homeDerived = useMemo'))
    expect(def).toBeGreaterThan(-1)
    expect(def).toBeLessThan(allBranch)
    // exactly one definition — a second copy is how the two branches drifted
    expect(hub.split('const isLivePersonH = (p) => !p.isJunk').length - 1).toBe(1)
  })

  it('both transfer-card branches run it — the hand-rolled isJunk-only filter is gone', () => {
    expect(hub).not.toContain('visibleTransferQueue(transferPeople, { isElevated }).filter(p => !p.isJunk)')
    expect(hub.split('visibleTransferQueue(transferPeople, { isElevated }).filter(isLivePersonH)').length - 1).toBe(2)
  })
})

// ── G) wiring pins ──────────────────────────────────────────────────────────
describe('G) the door is wired where it was specified', () => {
  it('the Inbox row ··· menu carries ONE entry, not two modes', () => {
    const inbox = src('components/hive/InboxScreen.jsx')
    expect(inbox).toContain('Add to Network…')
    expect(inbox).not.toContain('Move to Network…')
    expect(inbox).toContain('<NetworkConvertSheet')
  })

  it('the sheet asks both questions and posts one call', () => {
    const sheet = src('components/hive/NetworkConvertSheet.jsx')
    // Two mode cards, one specialty picker, one POST.
    expect(sheet).toMatch(/key: 'add'/)
    expect(sheet).toMatch(/key: 'move'/)
    expect(sheet).toContain('data-mode={m.key}')
    expect(sheet).toContain('specialties.map')
    expect((sheet.match(/method: 'POST'/g) || []).length).toBe(1)
  })

  it('ClientProfile hides the door once a twin exists (and while unknown)', () => {
    const cp = src('components/hive/ClientProfile.jsx')
    expect(cp).toContain('networkTwin === false')
    expect(cp).toContain('customer_lead_id=')
  })

  it('the partner timeline unions the linked lead history rather than moving it', () => {
    const tl = src('app/api/partners/[id]/timeline/route.ts')
    expect(tl).toContain("eq('lead_id', partner.customer_lead_id)")
    expect(tl).toContain('from_lead: true')
    // No subject flip anywhere — the XOR stays intact.
    expect(tl).not.toMatch(/update\(\s*\{\s*partner_id/)
  })

  it('last_contacted_at is seeded server-side (it is not PATCHable by design)', () => {
    const route = src('app/api/leads/[id]/network/route.ts')
    expect(route).toContain("eq('kind', 'reach_out')")
    expect(route).toContain('last_contacted_at: carriedAt')
    expect(src('lib/crm.ts')).not.toContain("lastContactedAt: 'last_contacted_at'")
  })
})
