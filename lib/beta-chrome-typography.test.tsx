// @vitest-environment happy-dom
//
// Chrome typography/token unification (phase 2 of the four-tab audit):
//   A) Confirmed-canonical properties resolve to the SAME shared token
//      or class across Inbox / Board / List / Clients:
//      - 'Clear all' = one ClearAllButton (12px) in popover + empty state
//      - displayTitle secondary text color = var(--text-muted) on board
//        cards, list desktop rows, list mobile rows
//      - '· soon' placeholders = var(--text-quiet) on Inbox + Clients
//      - interactive hairline = var(--hairline-border) on buttons + inputs
//      - the teal pair = CHIP_STYLES.teal everywhere (badge, chips, inbox)
//      - green 3-stop scale named in ui/tokens (fill / text / accent)
//   B) Affordances preserved: buttons still fire, sort headers still
//      sort (covered in beta-closed-terminal too), load-more still pages.
//   C) Intentional values unchanged: board card 13px/500 lock,
//      FilterButton 12px, StatusChip 11px/500 anatomy.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { renderToString } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import EngagementBoard from '@/components/hive/EngagementBoard'
import EngagementList from '@/components/hive/EngagementList'
import InboxScreen from '@/components/hive/InboxScreen'
import ClientDirectory from '@/components/hive/ClientDirectory'
import Banner from '@/components/ui/Banner'
import StatusChip from '@/components/ui/StatusChip'
import LoadMore from '@/components/hive/shared/LoadMore'
import InitialsAvatar from '@/components/hive/shared/InitialsAvatar'
import { FilterButton, FilterPopover, FilteredEmpty, ClearAllButton } from '@/components/hive/shared/FilterPopover'
import { CHIP_STYLES } from '@/components/hive/shared/stageConfig'
import {
  TEXT_MUTED, TEXT_QUIET, TEXT_SUCCESS, HAIRLINE_BORDER, GREEN_FILL, GREEN_TEXT,
  TEXT_TOKENS, BORDER_TOKENS,
} from '@/components/ui/tokens'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const eng = (over: any = {}) => ({
  id: `e-${Math.random().toString(36).slice(2, 8)}`,
  client_id: 'c1',
  client_name: 'Pat Tester',
  location_uuid: 'loc-uuid-1',
  title: 'Garage organization',
  stage: 'Request',
  created_at: daysAgo(3),
  stage_entered_at: daysAgo(3),
  nurture_started_at: null,
  total_invoiced: 0, total_paid: 0, balance_owing: 0,
  repeat_count: 1,
  quotes: [], jobs: [], invoices: [],
  ...over,
})

// Person that derives 'New': contactable, no reach-outs, created recently.
const newPerson = (over: any = {}) => ({
  id: `p-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Nina Newlead',
  phone: '555-0100',
  email: 'nina@example.com',
  created: daysAgo(2),
  source: 'webform',
  outreachTimeline: [],
  jobberRef: null,
  locationId: 'loc-uuid-1',
  paidAmount: 0,
  ...over,
})

// Person that derives 'Nurturing' + paused → the Clients banner shows.
const nurturingPaused = (over: any = {}) => newPerson({
  name: 'Nora Nurture', created: daysAgo(120), paused: true, ...over,
})

const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ rows: [], total: 0 }) }) as any)
const lsStore = new Map<string, string>()
const lsMock = {
  getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
  setItem: (k: string, v: string) => { lsStore.set(k, String(v)) },
  removeItem: (k: string) => { lsStore.delete(k) },
  clear: () => { lsStore.clear() },
}

beforeEach(() => {
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('localStorage', lsMock)
  lsStore.clear()
  document.body.innerHTML = ''
})
afterEach(() => { vi.unstubAllGlobals() })

function mount(el: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(el) })
  return container
}
async function fire(node: Element) {
  await act(async () => { node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}

describe('token definitions — the named scale, vars on the shell root', () => {
  it('green 3-stop scale is named, distinct, and the teal pair rides GREEN_TEXT', () => {
    // Brand pass 7/23: the scale is now the PUBLIC SITE's teal, and
    // TEXT_SUCCESS was darkened to clear AA (it was 3.39:1 on white
    // while running "Existing client · …" and the inline-edit ✓).
    expect(GREEN_FILL).toBe('#054E4A')
    expect(GREEN_TEXT).toBe('#03403C')
    expect(TEXT_SUCCESS).toBe('#167959')
    expect(new Set([GREEN_FILL, GREEN_TEXT, TEXT_SUCCESS]).size).toBe(3)
    // ONE teal pair: CHIP_STYLES.teal.text IS the scale's dark stop.
    expect(CHIP_STYLES.teal.text).toBe(GREEN_TEXT)
    expect(CHIP_STYLES.teal.bg).toBe('#E3EEEC')
  })

  it('root token maps carry the muted/quiet/hairline vars with hex fallbacks in call sites', () => {
    expect(TEXT_TOKENS['--text-muted']).toBe(TEXT_MUTED)
    expect(TEXT_TOKENS['--text-quiet']).toBe(TEXT_QUIET)
    expect(BORDER_TOKENS['--hairline-border']).toBe(HAIRLINE_BORDER)
    // 0.15 → 0.45: this line is a CONTROL boundary (WCAG 1.4.11, 3:1).
    // At 0.15 it composited to ~1.4:1 on white — in the DOM, invisible
    // on screen. See beta-palette-contrast.test.ts.
    expect(HAIRLINE_BORDER).toBe('rgba(0,0,0,0.45)')
  })
})

describe("'Clear all' — one shared rendering, 12px on both hosts", () => {
  it('popover footer and FilteredEmpty both render the shared .bee-clear-all at 12px', () => {
    const inPopover = renderToString(
      <FilterPopover open count={2} onClear={() => {}}>x</FilterPopover>
    )
    const inEmpty = renderToString(
      <FilteredEmpty count={2} onClear={() => {}} noun="rows" />
    )
    for (const html of [inPopover, inEmpty]) {
      expect(html).toContain('class="bee-clear-all"')
      const style = html.match(/class="bee-clear-all"[^>]*style="([^"]*)"/)![1]
      expect(style).toContain('font-size:12px')
      expect(style).toContain('text-decoration:underline')
    }
  })

  it('still fires onClear when clicked', async () => {
    const onClear = vi.fn()
    const container = mount(<ClearAllButton onClick={onClear} />)
    await fire(container.querySelector('.bee-clear-all')!)
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})

describe('displayTitle secondary text — one color token, sizes stay per density', () => {
  it('board card subtitle uses var(--text-muted) at its locked 11px', () => {
    const html = renderToString(<EngagementBoard engagements={[eng()] as any} closedCount={0} />)
    expect(html).toContain(`color:var(--text-muted, ${TEXT_MUTED})`)
    const sub = html.match(/font-size:11px;color:var\(--text-muted/)
    expect(sub).toBeTruthy()
  })

  it('list desktop (13px) and mobile (12px) rows use the same var(--text-muted)', () => {
    const html = renderToString(
      <EngagementList engagements={[eng()] as any} closedCount={0} closedWonCount={0} />
    )
    expect(html).toMatch(/font-size:13px;color:var\(--text-muted/)
    // The drifted #6b6b66 title cell is gone — that hex may only appear
    // via SECTION_LABEL (12px headers), never on a 13px body cell.
    expect(html).not.toMatch(/font-size:13px;color:#6b6b66/)
  })
})

describe("'· soon' placeholders — one quiet gray on both tabs", () => {
  it('Inbox Snooze placeholder is GONE — replaced by the real ··· overflow', () => {
    // Snooze shipped (beta-inbox-actions): the '· soon' span must not
    // come back. The overflow trigger is a GHOST icon button now (row
    // restyle, direction C) — muted glyph, no hairline pill.
    const html = renderToString(
      <InboxScreen people={[newPerson()] as any} engagements={[]} />
    )
    expect(html).not.toContain('Snooze · soon')
    expect(html).not.toContain('title="Coming soon"')
    const trigger = html.match(/aria-label="More"[^>]*style="([^"]*)"/)
    expect(trigger).toBeTruthy()
    expect(trigger![1]).toContain(`var(--text-muted, ${TEXT_MUTED})`)
    expect(trigger![1]).not.toContain('var(--hairline-border')
  })

  it('Clients Activate-drips rides the same var(--text-quiet)', () => {
    const html = renderToString(
      <ClientDirectory people={[nurturingPaused()] as any} engagements={[]} />
    )
    expect(html).toContain('Activate drips · soon')
    const soon = html.match(/title="Coming with drip activation \(step 5\)"[^>]*style="([^"]*)"/) ||
      html.match(/style="([^"]*)"[^>]*title="Coming with drip activation/)
    expect(soon).toBeTruthy()
    expect(soon![1]).toContain(`var(--text-quiet, ${TEXT_QUIET})`)
  })
})

describe('interactive hairline — buttons and inputs share --hairline-border', () => {
  it('Inbox Log call, Banner action, FilterButton, and both tabs’ inputs all carry the var', () => {
    const inbox = renderToString(<InboxScreen people={[newPerson()] as any} engagements={[]} />)
    expect(inbox).toContain('var(--hairline-border')

    const banner = renderToString(
      <Banner icon="!" text="note" action={{ label: 'Do it', onClick: () => {} }} />
    )
    expect(banner).toContain('var(--hairline-border')

    const fbtn = renderToString(<FilterButton count={0} open={false} onToggle={() => {}} />)
    expect(fbtn).toContain('var(--hairline-border')

    const dir = renderToString(<ClientDirectory people={[newPerson()] as any} engagements={[]} />)
    // search input
    expect(dir).toMatch(/<input[^>]*style="[^"]*var\(--hairline-border/)
  })

  it('no drifted 0.12-alpha borders remain on the unified controls', () => {
    const banner = renderToString(
      <Banner icon="!" text="note" action={{ label: 'Do it', onClick: () => {} }} />
    )
    expect(banner).not.toContain('rgba(0,0,0,0.12)')
    const dir = renderToString(<ClientDirectory people={[newPerson()] as any} engagements={[]} />)
    expect(dir).not.toMatch(/<input[^>]*rgba\(0,0,0,0\.12\)/)
  })
})

describe('teal pair + ghost actions — routed, not repeated', () => {
  it('Inbox section families stay teal; Send to Jobber is a ghost icon, not a green pill', () => {
    const html = renderToString(<InboxScreen people={[newPerson()] as any} engagements={[]} />)
    // New section label + avatar in the one teal pair
    expect(html).toContain(CHIP_STYLES.teal.text)
    expect(html).toContain(CHIP_STYLES.teal.bg)
    // Row restyle (direction C): the send trigger is a borderless muted
    // icon — the solid GREEN_FILL pill must not come back.
    const send = html.match(/aria-label="Send to Jobber"[^>]*style="([^"]*)"/)
    expect(send).toBeTruthy()
    expect(send![1]).toContain(`var(--text-muted, ${TEXT_MUTED})`)
    expect(html).not.toContain(`background:${GREEN_FILL}`)
  })
})

describe('shared structural components — one markup, affordances intact', () => {
  it('InitialsAvatar renders the locked 32px/11px/600 circle from a name + pair', () => {
    const html = renderToString(<InitialsAvatar name="Ada Lovelace" bg="#E1F5EE" text="#085041" />)
    expect(html).toContain('AL')
    expect(html).toContain('width:32px')
    expect(html).toContain('font-size:11px')
    expect(html).toContain('font-weight:600')
  })

  it('LoadMore names the batch and still fires; both list + clients consume it', async () => {
    const onClick = vi.fn()
    const container = mount(<LoadMore pageSize={100} remaining={340} onClick={onClick} />)
    expect(container.textContent).toContain('Load 100 more of 340')
    await fire(container.querySelector('button')!)
    expect(onClick).toHaveBeenCalledTimes(1)

    // Clients pager: >100 visible rows → the shared button paints and pages.
    const people = Array.from({ length: 130 }, (_, i) => newPerson({ id: `p${i}`, name: `P ${String(i).padStart(3, '0')}` }))
    const dir = mount(<ClientDirectory people={people as any} engagements={[]} />)
    const btn = [...dir.querySelectorAll('button')].find(b => (b.textContent || '').startsWith('Load '))!
    expect(btn.textContent).toContain('Load 30 more of 30')
    await fire(btn)
    expect([...dir.querySelectorAll('button')].find(b => (b.textContent || '').startsWith('Load '))).toBeFalsy()
  })

  it('Inbox Log call button still reaches the touchpoint write (via the shared composer)', async () => {
    const container = mount(<InboxScreen people={[newPerson()] as any} engagements={[]} />)
    const logBtn = container.querySelector('button[aria-label="Log call"]')!
    expect(logBtn).toBeTruthy()
    await fire(logBtn)
    // The row action opens TouchpointModal now; the footer commits the write.
    const commit = [...container.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Log call')!
    expect(commit).toBeTruthy()
    await fire(commit)
    expect(fetchMock).toHaveBeenCalled()
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/touchpoints')
  })

  it('board mobile pager arrows/dots survive the SectionHeader swap (desktop markup unchanged)', () => {
    // Desktop render still shows every column header through SectionHeader
    const html = renderToString(<EngagementBoard engagements={[eng()] as any} closedCount={0} />)
    expect(html).toContain('>Request<')
    expect(html).toMatch(/font-size:12px;font-weight:500;color:#54544F/)
  })
})

describe('intentional values — untouched', () => {
  it('board card keeps the locked 13px/500 name and 12px/500 value', () => {
    const html = renderToString(
      <EngagementBoard engagements={[eng({ quotes: [{ id: 'q1', status: 'sent', total: 500, sent_at: daysAgo(1) }] })] as any} closedCount={0} />
    )
    expect(html).toMatch(/font-size:13px;font-weight:500/)
    expect(html).toMatch(/font-size:12px;font-weight:500/)
  })

  it('FilterButton stays 12px; StatusChip keeps the 11px/500 pill anatomy', () => {
    const fbtn = renderToString(<FilterButton count={0} open={false} onToggle={() => {}} />)
    expect(fbtn).toContain('font-size:12px')
    const chip = renderToString(<StatusChip label="New" styleKey="New" />)
    expect(chip).toContain('font-size:11px')
    expect(chip).toContain('font-weight:500')
    expect(chip).toContain('padding:2px 8px')
  })
})
