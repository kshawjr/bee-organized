// @vitest-environment happy-dom
//
// Referrer VISIBILITY + meta-row rhythm (Kevin, 7/23 — two things he saw
// on the Inbox card). MOUNT tests throughout: every assertion below runs
// against real rendered DOM on the real surfaces, never a source regex.
// Two bugs got past source pins this week; a pin can't see a component
// that renders the wrong thing for the right-looking reason.
//
//   1) THE GATE — the referrer line only belongs on a referral-sourced
//      lead. It was rendering its "add referrer" invite on every lead,
//      Website / Google / Manual / MAKE-slug alike. Classic already had
//      this rule (BeeHub's "only when source is Referral"); beta lost it
//      in the ReferrerField extraction.
//
//      The gate is deliberately ASYMMETRIC, and that asymmetry is the
//      pinned decision here:
//        · nothing stored + non-referral source → render NOTHING
//        · a STORED referrer → ALWAYS render, whatever source says,
//          with its edit + clear controls intact
//      Rationale (Classic got this half wrong): hiding a stored referrer
//      because someone later re-picked Source erases the attribution
//      from every screen while the columns still hold it — an invisible
//      value is worse than an inconsistent one, and it would also strand
//      a wrong referrer with no UI able to clear it.
//
//   2) THE RHYTHM — the referrer line was a naked 12px div: no icon
//      well, so its text started at the card's left edge while every row
//      above it started 20px in; no muted label treatment; and it sat
//      under an 11px Source PILL. Three type sizes and three left edges
//      in one four-row block. All meta rows now read shared/metaRow, and
//      these tests assert rows against THAT shared style — not against
//      re-typed literals, which is how the drift happened in the first
//      place.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import PersonCard from '@/components/hive/PersonCard'
import ClientProfile from '@/components/hive/ClientProfile'
import ReferrerField, { isReferralSourced } from '@/components/hive/shared/ReferrerField'
import { metaRowStyle, META_ICON } from '@/components/hive/shared/metaRow'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()
const LOC = 'loc-uuid-1'
const LOOKUPS = { sources: ['Webform', 'Website', 'Referral'], projectTypes: ['Client'] }

const person = (over: any = {}) => ({
  id: 'lead-9', name: 'Dana Client', email: 'dana@x.com', phone: '(561) 555-0100',
  source: 'Webform', locationId: LOC, created: daysAgo(40), isJunk: false, outreachTimeline: [],
  ...over,
})

const PARTNER_ROWS = [
  { id: 'pt-1', name: 'Karen Partner', title: '', company: 'Staging Co', type: 'partner', isDeleted: false },
]

// The profile payload both cards fetch. `profileClient` is what each
// test varies — source + referrer columns.
let profileClient: any = {}
const profilePayload = () => ({
  client: {
    id: 'lead-9', name: 'Dana Client', first_name: 'Dana', last_name: 'Client',
    email: 'dana@x.com', phone: '(561) 555-0100', address: null, city: null, state: null, zip: null,
    created_at: daysAgo(40), source: 'Webform', paused: false, marketing_opt_out: false,
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    jobber_client_id: null, location_uuid: LOC, location_id: null,
    paid_amount: 0, request_details: null, project_type: 'Client', location_name: 'Denver',
    ...profileClient,
  },
  referred_us: [], contacts: [], engagements: [], touchpoints: [], buzz_notes: [], job_notes: [],
  aggregates: { lifetime_paid: 0, open_pipeline: 0, owing: 0, open_count: 0, total_count: 0 },
})

const jsonRes = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })
let patchBodies: any[] = []
const installFetch = () => {
  patchBodies = []
  profileClient = {}
  ;(globalThis as any).fetch = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    if (u.includes('/api/partners')) return jsonRes(PARTNER_ROWS)
    if (u.includes('/api/companies')) return jsonRes([])
    if (u.includes('/api/leads/') && opts.method === 'PATCH') {
      patchBodies.push(JSON.parse(opts.body))
      return jsonRes({ ok: true })
    }
    if (u.includes('/profile')) return jsonRes(profilePayload())
    return jsonRes({})
  })
}

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const flush = () => act(async () => {})
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})

const addBtn = (host: Element) => host.querySelector('button[aria-label="Add referrer"]')
const editBtn = (host: Element) => host.querySelector('button[aria-label="Edit referrer"]')
const clearBtn = (host: Element) => host.querySelector('button[aria-label="Clear referrer"]')
const row = (host: Element, name: string) => host.querySelector(`[data-meta-row="${name}"]`) as HTMLElement | null

beforeEach(() => installFetch())
afterEach(() => { document.body.style.overflow = ''; document.body.innerHTML = '' })

// ═══ 1) the gate — the source matrix ═══════════════════════════
describe('ReferrerField gate — source decides whether the field exists', () => {
  const mountField = (lead: any) => mount(
    <ReferrerField lead={{ id: 'lead-9', referred_by_kind: null, referred_by_id: null, referred_by_name: null, ...lead }}
      locationUuid={LOC} people={[]} />
  )

  it("source='Referral' → the add-referrer affordance renders", async () => {
    const { host, unmount } = await mountField({ source: 'Referral' })
    expect(addBtn(host)).toBeTruthy()
    await unmount()
  })

  // The real vocabulary: lookup labels, legacy webform slugs, and the
  // MAKE intake slugs. None of them is a referral; none may show it.
  for (const source of ['Website', 'Google', 'Manual', 'Webform', 'webform', 'seattle_assessment', 'Jobber', null, '', '   ']) {
    it(`source=${JSON.stringify(source)} → renders NOTHING at all`, async () => {
      const { host, unmount } = await mountField({ source })
      expect(addBtn(host)).toBeNull()
      expect(editBtn(host)).toBeNull()
      expect((host.textContent || '').trim()).toBe('')
      expect(host.querySelector('[data-meta-row="referrer"]')).toBeNull()
      await unmount()
    })
  }

  // Source labels are an admin-managed per-location lookup, so the gate
  // matches on the WORD, not on one exact spelling.
  for (const source of ['referral', 'REFERRAL', ' Referral ', 'Client Referral', 'Referral — Partner']) {
    it(`source=${JSON.stringify(source)} still counts as referral-sourced`, async () => {
      const { host, unmount } = await mountField({ source })
      expect(addBtn(host)).toBeTruthy()
      await unmount()
    })
  }

  it('the gate predicate is exported and agrees with what mounts', () => {
    expect(isReferralSourced('Referral')).toBe(true)
    expect(isReferralSourced('client referral')).toBe(true)
    expect(isReferralSourced('Website')).toBe(false)
    expect(isReferralSourced('seattle_assessment')).toBe(false)
    expect(isReferralSourced(null)).toBe(false)
    expect(isReferralSourced(undefined)).toBe(false)
  })

  it('readOnly + non-referral source + nothing stored → still nothing', async () => {
    const { host, unmount } = await mount(
      <ReferrerField lead={{ id: 'lead-9', source: 'Website', referred_by_kind: null }} locationUuid={LOC} people={[]} readOnly />
    )
    expect((host.textContent || '').trim()).toBe('')
    await unmount()
  })
})

// ═══ 2) THE EDGE CASE — stored referrer, non-referral source ═══
// The pinned decision: SHOW it. Attribution that exists in the columns
// must be visible on the card, and must stay clearable.
describe('stored referrer outlives a source change (the chosen behavior)', () => {
  const stored = { referred_by_kind: 'partner', referred_by_id: 'pt-1', referred_by_name: 'Karen Partner' }

  for (const source of ['Website', 'seattle_assessment', null]) {
    it(`source=${JSON.stringify(source)} + a stored referrer → the line SHOWS`, async () => {
      const { host, unmount } = await mount(
        <ReferrerField lead={{ id: 'lead-9', source, ...stored }} locationUuid={LOC} people={[]} />
      )
      expect(host.textContent).toContain('Referred by Karen Partner')
      await unmount()
    })
  }

  it('and keeps BOTH controls — a wrong referrer on a re-sourced lead is still editable and clearable', async () => {
    const { host, unmount } = await mount(
      <ReferrerField lead={{ id: 'lead-9', source: 'Website', ...stored }} locationUuid={LOC} people={[]} />
    )
    expect(editBtn(host)).toBeTruthy()
    expect(clearBtn(host)).toBeTruthy()
    await click(clearBtn(host)!)
    // Write contract untouched by this build: clear nulls both columns
    // and never touches source.
    expect(patchBodies).toEqual([{ referred_by_kind: null, referred_by_id: null }])
    await unmount()
  })

  it('read-only surfaces show the stored referrer too (display, no controls)', async () => {
    const { host, unmount } = await mount(
      <ReferrerField lead={{ id: 'lead-9', source: 'Website', ...stored }} locationUuid={LOC} people={[]} readOnly />
    )
    expect(host.textContent).toContain('Referred by Karen Partner')
    expect(editBtn(host)).toBeNull()
    expect(clearBtn(host)).toBeNull()
    await unmount()
  })
})

// ═══ 3) the gate is live on BOTH mounting surfaces ═════════════
const mountPersonCard = async () => {
  const mounted = await mount(
    <PersonCard person={person({ source: profileClient.source ?? 'Webform' })} people={[]}
      onClose={() => {}} lookupOptions={LOOKUPS} />
  )
  await flush()
  return mounted
}
const mountClientProfile = async () => {
  const mounted = await mount(<ClientProfile clientId="lead-9" people={[]} onClose={() => {}} />)
  await flush()
  return mounted
}

for (const [label, mountSurface] of [['PersonCard (the Inbox card)', mountPersonCard], ['ClientProfile', mountClientProfile]] as const) {
  describe(`${label} — referrer visibility`, () => {
    it('non-referral source, nothing stored → no referrer row anywhere on the card', async () => {
      profileClient = { source: 'Webform' }
      const { host, unmount } = await mountSurface()
      expect(addBtn(host)).toBeNull()
      expect(host.querySelector('[data-meta-row="referrer"]')).toBeNull()
      expect(host.textContent).not.toContain('referrer')
      await unmount()
    })

    it('a MAKE intake slug is not a referral either', async () => {
      profileClient = { source: 'seattle_assessment' }
      const { host, unmount } = await mountSurface()
      expect(addBtn(host)).toBeNull()
      await unmount()
    })

    it("source='Referral' → the referrer row is back", async () => {
      profileClient = { source: 'Referral' }
      const { host, unmount } = await mountSurface()
      expect(addBtn(host)).toBeTruthy()
      expect(row(host, 'referrer')).toBeTruthy()
      await unmount()
    })

    it('a stored referrer shows even though the source no longer says Referral', async () => {
      profileClient = { source: 'Website', referred_by_kind: 'partner', referred_by_id: 'pt-1', referred_by_name: 'Karen Partner' }
      const { host, unmount } = await mountSurface()
      expect(host.textContent).toContain('Referred by Karen Partner')
      await unmount()
    })
  })
}

// ═══ 4) the rhythm — every meta row wears the SHARED anatomy ═══
// Assertions read metaRowStyle() itself, so a future row that re-types
// its own numbers fails here instead of drifting quietly.
const SHARED = metaRowStyle()
const RHYTHM = ['fontSize', 'lineHeight', 'gap', 'alignItems', 'display'] as const

const styleOf = (el: HTMLElement) => ({
  fontSize: el.style.fontSize,
  lineHeight: el.style.lineHeight,
  gap: el.style.gap,
  alignItems: el.style.alignItems,
  display: el.style.display,
})

describe('meta-row rhythm — Source and Referrer match their neighbors', () => {
  it('PersonCard: phone / email / source / referrer all render the ONE shared anatomy', async () => {
    profileClient = { source: 'Referral', referred_by_kind: 'partner', referred_by_id: 'pt-1', referred_by_name: 'Karen Partner' }
    const { host, unmount } = await mountPersonCard()

    const rows = ['phone', 'email', 'source', 'referrer'].map(n => {
      const el = row(host, n)
      expect(el, `${n} row must render`).toBeTruthy()
      return [n, el!] as const
    })

    for (const [name, el] of rows) {
      for (const prop of RHYTHM) {
        expect(styleOf(el)[prop], `${name}.${prop}`).toBe(String((SHARED as any)[prop]))
      }
    }
    // And they agree with each other — no row is its own island.
    const referrer = styleOf(row(host, 'referrer')!)
    expect(referrer).toEqual(styleOf(row(host, 'source')!))
    expect(referrer).toEqual(styleOf(row(host, 'phone')!))
    await unmount()
  })

  it('PersonCard: the referrer row leads with an icon at the shared size — the value sits on the same left edge as the rows above', async () => {
    profileClient = { source: 'Referral', referred_by_kind: 'partner', referred_by_id: 'pt-1', referred_by_name: 'Karen Partner' }
    const { host, unmount } = await mountPersonCard()
    for (const name of ['phone', 'source', 'referrer']) {
      const icon = row(host, name)!.querySelector('svg')
      expect(icon, `${name} icon`).toBeTruthy()
      expect(icon!.getAttribute('width')).toBe(String(META_ICON))
    }
    await unmount()
  })

  it('PersonCard: Source is a ROW, not the 11px pill — same type size as the line beneath it', async () => {
    profileClient = { source: 'Referral', referred_by_kind: 'partner', referred_by_id: 'pt-1', referred_by_name: 'Karen Partner' }
    const { host, unmount } = await mountPersonCard()
    const source = row(host, 'source')!
    // Still the same control (a button into the MetaSelect popover) —
    // only its clothes changed.
    expect(source.tagName).toBe('BUTTON')
    expect(source.textContent).toContain('Source: Referral')
    expect(source.style.fontSize).toBe(SHARED.fontSize)
    await unmount()
  })

  it('PersonCard: the empty-state add-referrer row wears the anatomy too', async () => {
    profileClient = { source: 'Referral' }
    const { host, unmount } = await mountPersonCard()
    const el = row(host, 'referrer')!
    for (const prop of RHYTHM) {
      expect(styleOf(el)[prop], prop).toBe(String((metaRowStyle({ tone: 'faint' }) as any)[prop]))
    }
    expect(el.querySelector('svg')).toBeTruthy()
    await unmount()
  })

  it('ClientProfile: contact / address / source / referrer share the same anatomy', async () => {
    profileClient = {
      source: 'Referral', address: '12 Palm Ave', city: 'Denver', state: 'CO', zip: '80202',
      referred_by_kind: 'partner', referred_by_id: 'pt-1', referred_by_name: 'Karen Partner',
    }
    const { host, unmount } = await mountClientProfile()
    const referrer = styleOf(row(host, 'referrer')!)
    for (const name of ['phone', 'email', 'address', 'source']) {
      expect(styleOf(row(host, name)!), name).toEqual(referrer)
    }
    for (const prop of RHYTHM) {
      expect(referrer[prop], prop).toBe(String((SHARED as any)[prop]))
    }
    await unmount()
  })

  it('the referrer value carries the muted LABEL treatment its neighbors use ("Referred by" reads as a label, the name as the value)', async () => {
    const { host, unmount } = await mount(
      <ReferrerField lead={{ id: 'lead-9', source: 'Referral', referred_by_kind: 'partner', referred_by_id: 'pt-1', referred_by_name: 'Karen Partner' }}
        locationUuid={LOC} people={[]} />
    )
    const value = editBtn(host)!
    const labelSpan = value.querySelector('span') as HTMLElement
    expect(labelSpan.textContent).toBe('Referred by ')
    // Muted label vs the row's own (primary) ink — the same two-tone
    // split "Source: Referral" renders.
    expect(labelSpan.style.color).toBeTruthy()
    expect(labelSpan.style.color).not.toBe(row(host, 'referrer')!.style.color)
    await unmount()
  })
})
