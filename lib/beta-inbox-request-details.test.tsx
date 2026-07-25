// @vitest-environment happy-dom
// Inbox row request_details line — ALWAYS present (#68).
//
// The webform snippet (leads.request_details → mapper jobDetail) used to be
// truthiness-gated, so rows with a value ran ~16px taller than rows without
// and the list rhythm was ragged. Kevin's call: the field is first-class and
// the data will fill in — the LINE is permanent, emptiness is the legacy
// intake gap. Covers:
//   - populated row: value rendered, title attr carries the FULL value (the
//     one-line ellipsis is lossy; the tooltip is the only escape hatch)
//   - null / '' / whitespace-only: placeholder rendered, element PRESENT —
//     a test that passes on an absent <p> would mean the gate came back,
//     so presence is asserted explicitly on every branch
//   - populated and empty rows carry identical layout-driving styles on the
//     same slot (same height by construction — happy-dom does no real layout)
//   - placeholder is visually quieter (softened + italic) and carries no
//     title (a tooltip saying "no details" is noise)
//   - transfer rows keep their origin line INSTEAD of the snippet (deliberate,
//     unchanged)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import InboxScreen from '@/components/hive/InboxScreen'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const PLACEHOLDER = 'No request details yet'

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

let seq = 0
const person = (over: any = {}) => ({
  id: `p-${++seq}-${Math.random().toString(36).slice(2, 6)}`,
  name: `Lead ${seq}`,
  email: 'lead@email.com',
  phone: '(561) 555-0199',
  locationId: 'loc-uuid-1',
  created: daysAgo(3), // < 30d, no outreach → derived New
  isJunk: false,
  snoozeUntil: null,
  inboxDismissedAt: null,
  jobberRef: null,
  outreachTimeline: [],
  ...over,
})

const jsonRes = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })
beforeEach(() => {
  ;(globalThis as any).fetch = vi.fn(async () => jsonRes({}))
})

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return {
    host,
    unmount: async () => { await act(async () => root.unmount()); host.remove() },
  }
}

const inbox = (people: any[], over: any = {}) => (
  <InboxScreen people={people} engagements={[]} locFilter="all" setToast={() => {}} {...over} />
)

const rowByName = (host: Element, name: string) =>
  [...host.querySelectorAll('.bee-inbox-row')].find(r => (r.textContent || '').includes(name))!
const detailIn = (row: Element) => row.querySelector('p.bee-inbox-detail') as HTMLParagraphElement | null

describe('request_details line — always present (#68)', () => {
  it('populated row renders the value with a full-value title attr', async () => {
    const m = await mount(inbox([person({ name: 'Alice Apple', jobDetail: 'Garage full of boxes, need weekly help' })]))
    const detail = detailIn(rowByName(m.host, 'Alice Apple'))
    expect(detail, 'snippet <p> must be present').toBeTruthy()
    expect(detail!.textContent).toBe('Garage full of boxes, need weekly help')
    expect(detail!.getAttribute('title')).toBe('Garage full of boxes, need weekly help')
    await m.unmount()
  })

  it.each([
    ['null', null],
    ['empty string', ''],
    ['whitespace-only', '   '],
  ])('%s jobDetail renders the placeholder — element PRESENT, no title', async (_label, value) => {
    const m = await mount(inbox([person({ name: 'Bob Berry', jobDetail: value })]))
    const detail = detailIn(rowByName(m.host, 'Bob Berry'))
    // Explicit presence: an absent <p> means the truthiness gate came back.
    expect(detail, 'placeholder <p> must be present, not conditionally absent').toBeTruthy()
    expect(detail!.textContent).toBe(PLACEHOLDER)
    expect(detail!.hasAttribute('title')).toBe(false)
    await m.unmount()
  })

  it('populated and empty rows occupy the same slot — identical layout-driving styles', async () => {
    const m = await mount(inbox([
      person({ name: 'Carla Cherry', jobDetail: 'Declutter the home office before a move' }),
      person({ name: 'Dev Damson', jobDetail: null }),
    ]))
    const full = detailIn(rowByName(m.host, 'Carla Cherry'))
    const empty = detailIn(rowByName(m.host, 'Dev Damson'))
    expect(full, 'populated snippet must be present').toBeTruthy()
    expect(empty, 'empty-state snippet must be present').toBeTruthy()
    // happy-dom does no real layout, so equal height is asserted by
    // construction: both are the same element in the same slot with the
    // same height-driving styles (font size, single-line, top margin).
    for (const prop of ['font-size', 'margin-top', 'white-space', 'overflow'] as const) {
      expect(empty!.style.getPropertyValue(prop), prop).toBe(full!.style.getPropertyValue(prop))
    }
    // …and the placeholder reads as absence, not content: quieter + italic.
    expect(empty!.style.getPropertyValue('font-style')).toBe('italic')
    expect(Number(empty!.style.getPropertyValue('opacity'))).toBeLessThan(1)
    expect(full!.style.getPropertyValue('font-style')).toBe('')
    await m.unmount()
  })

  it('transfer rows keep the origin line and render NO snippet — populated or not', async () => {
    const t = person({
      name: 'Eve Elder', jobDetail: 'Big cleanout',
      originCity: 'Boise', originState: 'ID', originZip: '83702', project: 'Declutter',
    })
    const m = await mount(inbox([], { transferPeople: [t] }))
    const row = rowByName(m.host, 'Eve Elder')
    expect(row, 'needs-transfer row should render').toBeTruthy()
    expect(detailIn(row)).toBeNull()
    expect(row.textContent).toContain('Boise, ID 83702')
    expect(row.textContent).toContain('from global form')
    expect(row.textContent).not.toContain('Big cleanout')
    await m.unmount()
  })
})
