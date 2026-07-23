// @vitest-environment happy-dom
//
// Hive design-system pass (Kevin 7/10, sharp/clean/modern) — the pins:
//
//   A) SOURCE SWEEP: shared/tokens.js is the ONLY home for visual hex/
//      rgba literals in the hive chunk (mirrors the inline-edit pencil
//      sweep). A new hardcoded color anywhere else in components/hive/**
//      (or StatusChip, which renders the hive chip anatomy) fails here.
//   B) Token values: the sharpened palette headliners — warm canvas,
//      card lift border + two-layer shadow, warm hairlines, the radius
//      scale, ONE accent (= ui/tokens GREEN_FILL, lockstep-pinned).
//   C) One-accent buttons: cardKit's action tones all resolve to the
//      accent pair (the old blue/forest split is dead); the panel's
//      Call action renders in accent ink.
//   D) Chips: StatusChip = 8px RECTANGLE (T.radius.chip); tags stay
//      pills (TagsRow source pin).
//   E) Milestone records view (EngagementPanel): done = filled accent
//      check node, current = ring node, not-yet-reached = hollow
//      placeholders completing the expected arc; the Assessment step
//      appears ONLY when the engagement carries assessment records;
//      closed engagements render no placeholders. milestoneFamilies
//      derives from the stage machine's canonical order.
//   F) Visual-consistency pass (7/11): the milestone rail runs a
//      CONTINUOUS line node-to-node (absolute connector, can't collapse);
//      ONE chip/pill/avatar token scale both cards reach for
//      (T.badge/T.avatar + cardKit.pillStyle); the modal card lift
//      (warm border + two-layer soft shadow + 16r); the masthead Type is
//      a quiet editable meta value (no bordered box); figures carry
//      tabular numerals + tracking.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { T } from '@/components/hive/shared/tokens'
import { GREEN_FILL, GREEN_TEXT } from '@/components/ui/tokens'
import { ACTION_TONES, actionBtn } from '@/components/hive/shared/cardKit'
import { milestoneFamilies, STAGE_RECORD_FAMILY, CHIP_STYLES } from '@/components/hive/shared/stageConfig'
import StatusChip from '@/components/ui/StatusChip'
import EngagementPanel from '@/components/hive/EngagementPanel'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

beforeEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

// ── A) source sweep — tokens.js is the only literal home ───────
describe('token source sweep', () => {
  const HEX = /#[0-9a-fA-F]{3,8}\b/
  const RGBA = /rgba?\(/
  const sweep = (root: string, exempt: string[] = []) =>
    (readdirSync(root, { recursive: true }) as string[])
      .filter(f => /\.(jsx?|tsx?)$/.test(String(f)))
      .filter(f => !exempt.includes(String(f)))
      .filter(f => {
        const src = readFileSync(join(root, String(f)), 'utf8')
        return HEX.test(src) || RGBA.test(src)
      })

  it('components/hive/** carries NO hex/rgba literal outside shared/tokens.js (comments included — reword, don’t cite hexes)', () => {
    expect(sweep('components/hive', [join('shared', 'tokens.js')])).toEqual([])
  })

  it('StatusChip (the chip anatomy) resolves colors through CHIP_STYLES and radius through tokens — no literals', () => {
    const src = readFileSync('components/ui/StatusChip.jsx', 'utf8')
    expect(HEX.test(src)).toBe(false)
    expect(RGBA.test(src)).toBe(false)
    expect(src).toContain('T.radius.chip')
  })
})

// ── B) the sharpened palette values ─────────────────────────────
describe('token values — sharpened light palette', () => {
  it('warm canvas + card lift: real border + two-layer soft shadow', () => {
    expect(T.surface.canvas).toBe('#F6F5F0')
    expect(T.border.card).toBe('1px solid #ECEAE3')
    expect(T.shadow.card).toBe('0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.05)')
  })

  it('hairlines are the warm family, not cold rgba grays', () => {
    for (const v of Object.values(T.hairline)) {
      expect(v).toMatch(/^#[0-9A-F]{6}$/i)
    }
    expect(T.hairline.soft).toBe('#F0EEE7')
  })

  it('ONE accent — the brand teal, lockstep with ui/tokens GREEN_FILL/GREEN_TEXT', () => {
    expect(T.accent.fg).toBe(GREEN_FILL)
    expect(T.accent.fg).toBe('#0F6E56')
    expect(T.accent.deep).toBe(GREEN_TEXT)
  })

  it('radius scale: cards 16 / insets+buttons 11 / controls+chips 8 / tags stay pill', () => {
    expect(T.radius.card).toBe('16px')
    expect(T.radius.inset).toBe('11px')
    expect(T.radius.control).toBe('8px')
    expect(T.radius.chip).toBe('8px')
    expect(T.radius.pill).toBe('20px')
  })

  it('chip families stay the locked §8.6 pairs (they encode meaning — never collapsed into the accent)', () => {
    expect(T.family.teal.bg).toBe('#E1F5EE')
    expect(CHIP_STYLES.teal).toEqual(T.family.teal)
    expect(CHIP_STYLES.blue).toEqual(T.family.blue)
    expect(CHIP_STYLES.red).toEqual(T.family.red)
  })

  it('the CORPORATE sand is its own family — a category marker, not an urgency one', () => {
    // It marks "no location owns this yet". If it ever collapses into the
    // action accent a corporate container reads as clickable; if it collapses
    // into danger/warning it reads as overdue. Both are wrong.
    for (const v of [T.corp.bg, T.corp.border, T.corp.fg, T.corp.deep, T.corp.fill]) {
      expect(v).toMatch(/^#[0-9A-F]{6}$/i)
    }
    expect(T.corp.fill).not.toBe(T.accent.fg)
    expect(T.corp.fill).not.toBe(T.state.warning.fg)
    expect(T.corp.fill).not.toBe(T.state.danger.strong)
    expect(T.corp.bg).not.toBe(T.state.warning.bg)
    expect(T.corp.onFill).toBe(T.ink.inverse)
  })
})

// ── C) one-accent action buttons ────────────────────────────────
describe('one accent — action tones unified', () => {
  it('blue/green legacy tones AND accent all resolve to the accent pair; the forest/blue split is dead', () => {
    expect(ACTION_TONES.accent).toEqual({ bg: T.accent.soft, text: T.accent.deep })
    expect(ACTION_TONES.blue).toEqual(ACTION_TONES.accent)
    expect(ACTION_TONES.green).toEqual(ACTION_TONES.accent)
    expect(actionBtn('accent').color).toBe(T.accent.deep)
    expect(actionBtn('gray').color).toBe(T.ink.strong)
  })
})

// ── D) chips are rectangles; tags stay pills ────────────────────
describe('chip anatomy', () => {
  it('StatusChip renders an 8px-radius rectangle (pill era over)', () => {
    const html = renderToString(<StatusChip label="Estimate" styleKey="Estimate" />)
    expect(html).toContain('border-radius:8px')
    expect(html).not.toContain('border-radius:10px')
  })

  it('TagsRow keeps the pill radius for tags (categorical — pill is right there) via the SHARED pillStyle', () => {
    const cardKit = readFileSync('components/hive/shared/cardKit.jsx', 'utf8')
    // the pill radius is single-homed in cardKit.pillStyle now (one scale
    // both cards reach for), not re-declared per component
    expect(cardKit).toContain('export const pillStyle')
    expect(cardKit).toContain('T.radius.pill')
    // TagsRow composes it rather than hand-rolling a pill
    const src = readFileSync('components/hive/shared/TagsRow.jsx', 'utf8')
    expect(src).toContain('pillStyle')
  })
})

// ── E) milestone records view ───────────────────────────────────
const basePayload = (over: any = {}) => ({
  engagement: {
    id: 'eng-1', title: 'Kitchen + Pantry', stage: 'Estimate', founded_by: 'request',
    created_at: '2026-06-01T12:00:00Z', stage_entered_at: '2026-06-20T12:00:00Z',
    location_uuid: 'loc-1', project_type: null, description: null,
    total_invoiced: 0, total_paid: 0, balance_owing: 0,
    ...(over.engagement || {}),
  },
  children: {
    service_requests: [{ id: 'sr-1', requested_at: '2026-06-01T12:00:00Z', created_at: '2026-06-01T12:00:00Z', source: 'web', request_url: 'https://secure.getjobber.com/requests/r1' }],
    assessments: [],
    quotes: [{ id: 'q-1', total: 1200, status: 'sent', sent_at: '2026-06-21T12:00:00Z', quote_url: 'https://secure.getjobber.com/quotes/q1' }],
    jobs: [], invoices: [], notes: [], touchpoints: [],
    ...(over.children || {}),
  },
  client: {
    id: 'lead-9', name: 'Dana Client', email: 'dana@x.com', phone: '(561) 555-0100',
    request_details: null, source: null, referred_by_kind: null, referred_by_id: null,
    referred_by_name: null, buzz: [], lifetime_paid: 0, prior_engagements: 0, other_open: 0,
    ...(over.client || {}),
  },
})

const stubEngagementFetch = (payload: any) => {
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    if (String(url).includes('/api/engagements/')) {
      return { ok: true, status: 200, json: async () => payload }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }))
}

const nodes = (host: Element, kind: string) =>
  host.querySelectorAll(`[aria-label="Milestone ${kind}"]`)

describe('milestone records view', () => {
  it('derivation: the arc comes from the stage machine (rank order), assessment slots in only when records say so', () => {
    expect(milestoneFamilies()).toEqual(['request', 'quote', 'job', 'invoice'])
    expect(milestoneFamilies({ hasAssessment: true })).toEqual(['request', 'assessment', 'quote', 'job', 'invoice'])
    // the map the arc is built from — one home, panel + arc agree
    expect(STAGE_RECORD_FAMILY['Estimate']).toBe('quote')
    expect(STAGE_RECORD_FAMILY['Final Processing']).toBe('invoice')
  })

  it('Estimate-stage engagement: request done (✓ + ↗), quote current (ring), Job + Invoice hollow placeholders — full arc visible, no dates on placeholders', async () => {
    stubEngagementFetch(basePayload())
    const { host, unmount } = await mount(
      <EngagementPanel engagementId="eng-1" onClose={() => {}} setToast={() => {}} />
    )
    expect(nodes(host, 'done').length).toBe(1)      // the request
    expect(nodes(host, 'current').length).toBe(1)   // the sent quote
    expect(nodes(host, 'upcoming').length).toBe(2)  // Job, Invoice placeholders
    expect(host.textContent).toContain('Job')
    expect(host.textContent).toContain('Invoice')
    expect(host.textContent).not.toContain('Assessment')
    // done request keeps its Build-1 deep link
    const links = Array.from(host.querySelectorAll('a[aria-label="Open in Jobber"]'))
    expect(links.some(a => (a as HTMLAnchorElement).href.includes('/requests/r1'))).toBe(true)
    await unmount()
  })

  it('assessment placeholder is CONDITIONAL: with an assessment record the step renders (done when completed)', async () => {
    stubEngagementFetch(basePayload({
      children: {
        assessments: [{ id: 'as-1', scheduled_at: '2026-06-10T15:00:00Z', completed_at: '2026-06-10T16:00:00Z', status: 'completed' }],
      },
    }))
    const { host, unmount } = await mount(
      <EngagementPanel engagementId="eng-1" onClose={() => {}} setToast={() => {}} />
    )
    expect(host.textContent).toContain('Assessment')
    expect(nodes(host, 'done').length).toBe(2) // request + completed assessment
    await unmount()
  })

  it('closed engagement: records render as history — NO hollow placeholders, nothing current', async () => {
    stubEngagementFetch(basePayload({
      engagement: { stage: 'Closed Won', closed_at: '2026-07-01T12:00:00Z', closed_reason: 'won' },
      children: {
        quotes: [{ id: 'q-1', total: 1200, status: 'approved', sent_at: '2026-06-21T12:00:00Z', approved_at: '2026-06-25T12:00:00Z' }],
        jobs: [{ id: 'j-1', title: 'Kitchen', total: 1200, status: 'complete', completed_at: '2026-06-30T12:00:00Z' }],
        invoices: [{ id: 'i-1', total: 1200, status: 'paid', paid_amount: 1200, balance_owing: 0, issued_at: '2026-06-30T12:00:00Z', paid_at: '2026-07-01T12:00:00Z' }],
      },
    }))
    const { host, unmount } = await mount(
      <EngagementPanel engagementId="eng-1" onClose={() => {}} setToast={() => {}} />
    )
    expect(nodes(host, 'upcoming').length).toBe(0)
    expect(nodes(host, 'current').length).toBe(0)
    expect(nodes(host, 'done').length).toBe(4) // request, quote, job, invoice
    await unmount()
  })

  it('the Call action wears the accent (one-accent rule, DOM-level)', async () => {
    stubEngagementFetch(basePayload())
    const { host, unmount } = await mount(
      <EngagementPanel engagementId="eng-1" onClose={() => {}} setToast={() => {}} />
    )
    const call = Array.from(host.querySelectorAll('a[href^="tel:"]'))[0] as HTMLElement
    expect(call).toBeTruthy()
    expect([T.accent.deep, 'rgb(8, 80, 65)']).toContain(call.style.color)
    await unmount()
  })
})

// ── F) visual-consistency pass (7/11) ───────────────────────────
describe('milestone rail — continuous line node-to-node', () => {
  it('an absolute connector sits between EVERY non-last node, pinned node-bottom → row-bottom so it can NEVER collapse to a nub', async () => {
    stubEngagementFetch(basePayload()) // Estimate arc: request·quote·job·invoice = 4 rows
    const { host, unmount } = await mount(
      <EngagementPanel engagementId="eng-1" onClose={() => {}} setToast={() => {}} />
    )
    const conns = Array.from(host.querySelectorAll('[data-rail-connector]')) as HTMLElement[]
    expect(conns.length).toBe(3) // rows - 1: a segment under every node but the last
    conns.forEach(c => {
      const css = c.style.cssText
      expect(css).toContain('position: absolute') // pinned, not a flex:1 spacer that collapses
      expect(css).toContain('bottom: 0')          // reaches the row bottom → meets the next node flush
      expect(css).toContain('top: 18px')          // starts at the node's bottom edge (no gap at the node)
      expect(css.includes('solid') || css.includes('dashed')).toBe(true)
    })
    // solid THROUGH real records, dashed INTO the future placeholders
    const borders = conns.map(c => c.style.cssText)
    expect(borders.some(b => b.includes('solid'))).toBe(true)
    expect(borders.some(b => b.includes('dashed'))).toBe(true)
    await unmount()
  })
})

describe('one chip / pill / avatar token scale — both cards reach for it', () => {
  it('T.badge + T.avatar carry the shared anatomy (font/weight/height + avatar sizes)', () => {
    expect(T.badge).toMatchObject({ font: '11px', weight: 500, height: '22px' })
    expect(T.avatar).toMatchObject({ identity: '32px', inline: '18px' })
  })

  it('cardKit.pillStyle is the ONE pill home (radius + height), composed by both cards’ pill blocks', () => {
    const kit = readFileSync('components/hive/shared/cardKit.jsx', 'utf8')
    expect(kit).toContain('export const pillStyle')
    expect(kit).toContain('T.radius.pill')
    expect(kit).toContain('T.badge.height')
    // panel pill (assignees) + profile pills (tags, contacts) all compose it
    for (const f of ['EngagementAssignees.jsx', 'TagsRow.jsx', 'ContactsBlock.jsx']) {
      expect(readFileSync(join('components/hive/shared', f), 'utf8'), f).toContain('pillStyle')
    }
  })

  it('StatusChip reads its type from T.badge; InitialsAvatar + the inline avatar read T.avatar (no per-component drift)', () => {
    expect(readFileSync('components/ui/StatusChip.jsx', 'utf8')).toContain('T.badge')
    expect(readFileSync('components/hive/shared/InitialsAvatar.jsx', 'utf8')).toContain('T.avatar.identity')
    expect(readFileSync('components/hive/shared/EngagementAssignees.jsx', 'utf8')).toContain('T.avatar.inline')
  })
})

describe('modal card lift (both overlays)', () => {
  it('the shell card wears the warm border + 16r + a TWO-layer soft shadow (the board/list lift)', () => {
    const shell = readFileSync('components/hive/OverlayShell.jsx', 'utf8')
    expect(shell).toContain('T.border.card')
    expect(shell).toContain('T.radius.card')
    expect(shell).toContain('T.shadow.overlay')
    // two-layer = two rgba stops (contact + deep drop), like T.shadow.card
    expect((T.shadow.overlay.match(/rgba\(/g) || []).length).toBeGreaterThanOrEqual(2)
    expect(T.radius.card).toBe('16px')
  })
})

describe('masthead Type — a quiet editable meta value, not a bordered box', () => {
  it('renders the value under a Type label with the inline-edit affordance; the old "Type: …" pill box is gone', async () => {
    stubEngagementFetch(basePayload({ engagement: { project_type: 'Client' } }))
    const { host, unmount } = await mount(
      <EngagementPanel engagementId="eng-1" onClose={() => {}} setToast={() => {}} lookupOptions={{ sources: [], projectTypes: ['Client', 'Move'] } as any} />
    )
    const typeCell = host.querySelector('[aria-label="Edit type"]') as HTMLElement
    expect(typeCell).toBeTruthy()
    expect(typeCell.textContent).toContain('Client')
    expect(typeCell.style.border === '' || typeCell.style.border.includes('none')).toBe(true) // borderless value, no box
    expect([...host.querySelectorAll('button')].some(b => (b.textContent || '').includes('Type: Client'))).toBe(false)
    await unmount()
  })
})

describe('masthead meta-row — Type + Assigned align without a phantom stretch column', () => {
  it('groups Type + Assigned under one hairline-topped row and NEITHER cell grows (the flex:1 1 220px dead-band scrunch is gone)', async () => {
    stubEngagementFetch(basePayload())
    const { host, unmount } = await mount(
      <EngagementPanel engagementId="eng-1" onClose={() => {}} setToast={() => {}} lookupOptions={{ sources: [], projectTypes: ['Client', 'Move'] } as any} />
    )
    const labels = [...host.querySelectorAll('p')].filter(p => ['Type', 'Assigned to'].includes((p.textContent || '').trim()))
    const typeLabel = labels.find(p => (p.textContent || '').trim() === 'Type')!
    const assignLabel = labels.find(p => (p.textContent || '').trim() === 'Assigned to')!
    expect(typeLabel).toBeTruthy()
    expect(assignLabel).toBeTruthy()
    // Type cell wraps its MicroLabel directly; the Assigned cell wraps the
    // EngagementAssignees root (which owns the "Assigned to" MicroLabel).
    const typeCell = typeLabel.parentElement as HTMLElement
    const assignCell = (assignLabel.closest('div') as HTMLElement).parentElement as HTMLElement
    // ONE aligned meta-row — same parent, grouped by a hairline top rule.
    expect(typeCell.parentElement).toBe(assignCell.parentElement)
    const row = typeCell.parentElement as HTMLElement
    expect(row.style.borderTop).toBe(T.border.divider)
    // NEITHER cell greedily eats the masthead width — the old bug was
    // flex:'1 1 220px' on the Assigned cell (grow:1 + 220px basis), which
    // stretched its wrapper across the row while its content sat left,
    // leaving the dead band. Both are content-sized now.
    for (const cell of [typeCell, assignCell]) {
      expect(cell.style.flex).not.toContain('220')
      expect(cell.style.flexGrow === '1').toBe(false)
    }
    await unmount()
  })
})

describe('figures — tabular numerals + tracking', () => {
  it('the masthead deal value and the money in record rows are tabular + tracked', async () => {
    stubEngagementFetch(basePayload())
    const { host, unmount } = await mount(
      <EngagementPanel engagementId="eng-1" onClose={() => {}} setToast={() => {}} />
    )
    const ps = Array.from(host.querySelectorAll('p')) as HTMLElement[]
    const value = ps.find(p => p.textContent === '$1,200')! // masthead deal value (best quote)
    expect(value.style.fontVariantNumeric).toBe('tabular-nums')
    expect(value.style.letterSpacing).toBe(T.type.trackNum)
    const quoteRow = ps.find(p => (p.textContent || '').startsWith('Quote'))! // milestone record row
    expect(quoteRow.style.fontVariantNumeric).toBe('tabular-nums')
    expect(quoteRow.style.letterSpacing).toBe(T.type.trackTitle)
    await unmount()
  })
})
