// @vitest-environment happy-dom
//
// THE unified touchpoint composer. Logging a touchpoint used to be an inline
// wedge — a select + a one-line input + a "Log" button squeezed onto one flex
// row — copy-pasted onto the engagement card and the client profile, while the
// Inbox row did something else entirely (one click, call-only, no notes). One
// center modal replaces all three.
// Pins:
//   · 4 method tiles; the Log button restates the method it will write
//   · the outcome row is optional and CLEARABLE (re-tap the live chip → null),
//     and writes touchpoints.status — free text in the schema, already
//     rendered by Timeline, so it needs no backend
//   · notes come off a real textarea (16px — iOS auto-zooms below that and
//     never unwinds)
//   · Esc closes, and the dialog announces itself
//   · the modal NEVER writes: it hands the payload to the caller, because the
//     three surfaces post different bodies and hand up through their own seams
//   · the profile posts the composed body and hands up the RAW server row —
//     the tmp-id landmine that would have double-counted it is gone
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import TouchpointModal, { METHODS, OUTCOMES } from '@/components/hive/TouchpointModal'
import HiveShell from '@/components/hive/HiveShell'
import { mergePeopleTouches } from '@/components/hive/shared/peopleTouchPatch'
import { deriveClientStatus } from '@/components/hive/shared/clientStatus'
import { touchpointToTimelineEntry } from '@/lib/people-mapper'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

vi.mock('@/lib/supabase', () => ({
  createClient: () => {
    const ch: any = {}
    ch.on = () => ch
    ch.subscribe = () => ch
    return { channel: () => ch, removeChannel: () => {} }
  },
}))

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

// ═══ 1) the modal, standalone ══════════════════════════════════
describe('TouchpointModal', () => {
  let host: HTMLDivElement
  let root: Root

  const mount = async (props: any = {}) => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root.render(<TouchpointModal personName="Sarah Mitchell" onClose={() => {}} onSubmit={async () => {}} {...props} />)
    })
  }

  afterEach(async () => {
    if (root) await act(async () => root.unmount())
    if (host) host.remove()
    vi.restoreAllMocks()
  })

  const buttons = () => Array.from(host.querySelectorAll('button'))
  const byText = (t: string) => buttons().find(b => (b.textContent || '').trim() === t)
  const tile = (label: string) => buttons().find(b => b.getAttribute('aria-label') === label)!
  const notes = () => host.querySelector('textarea[aria-label="Notes"]') as HTMLTextAreaElement
  const type = async (el: HTMLTextAreaElement, v: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('renders the four method tiles, Call live by default', async () => {
    await mount()
    for (const m of METHODS) expect(tile(m.label), `${m.label} tile`).toBeTruthy()
    expect(tile('Call').getAttribute('aria-checked')).toBe('true')
    expect(tile('Email').getAttribute('aria-checked')).toBe('false')
  })

  it('picking a method moves the selection AND restates the Log button', async () => {
    // The label is the read-back: "Log text" tells you what is about to be
    // written; the wedge's bare "Log" told you nothing.
    await mount()
    expect(byText('Log call')).toBeTruthy()

    await act(async () => { tile('Text').click() })
    expect(byText('Log text')).toBeTruthy()
    expect(byText('Log call')).toBeFalsy()
    expect(tile('Text').getAttribute('aria-checked')).toBe('true')
    expect(tile('Call').getAttribute('aria-checked')).toBe('false')

    await act(async () => { tile('In person').click() })
    expect(byText('Log in person')).toBeTruthy()
  })

  it('every method tile has a verb — no tile can render a stale label', async () => {
    await mount()
    for (const m of METHODS) {
      await act(async () => { tile(m.label).click() })
      expect(byText(m.verb), `${m.value} → ${m.verb}`).toBeTruthy()
    }
  })

  it('outcome chips toggle, are mutually exclusive, and re-tapping the live one CLEARS it', async () => {
    const onSubmit = vi.fn(async () => {})
    await mount({ onSubmit })
    const chip = (l: string) => byText(l)!

    await act(async () => { chip('No answer').click() })
    expect(chip('No answer').getAttribute('aria-checked')).toBe('true')

    // exclusive: picking another moves the outcome, never stacks it
    await act(async () => { chip('Reached').click() })
    expect(chip('Reached').getAttribute('aria-checked')).toBe('true')
    expect(chip('No answer').getAttribute('aria-checked')).toBe('false')

    // clearable: the row is optional, so the live chip has to be un-pickable
    await act(async () => { chip('Reached').click() })
    expect(chip('Reached').getAttribute('aria-checked')).toBe('false')

    await act(async () => { byText('Log call')!.click() })
    expect(onSubmit).toHaveBeenCalledWith({ method: 'call', status: null, notes: null })
  })

  it('hands the caller the composed payload — method, outcome, trimmed notes', async () => {
    const onSubmit = vi.fn(async () => {})
    await mount({ onSubmit })
    await act(async () => { tile('Text').click() })
    await act(async () => { byText('Left voicemail')!.click() })
    await type(notes(), '  Said to try Monday  ')
    await act(async () => { byText('Log text')!.click() })

    expect(onSubmit).toHaveBeenCalledWith({ method: 'sms', status: 'voicemail', notes: 'Said to try Monday' })
  })

  it('empty notes hand up null, not an empty string', async () => {
    const onSubmit = vi.fn(async () => {})
    await mount({ onSubmit })
    await type(notes(), '   ')
    await act(async () => { byText('Log call')!.click() })
    expect(onSubmit).toHaveBeenCalledWith({ method: 'call', status: null, notes: null })
  })

  it('the notes field is a real textarea at 16px (iOS auto-zooms below that and never unwinds)', async () => {
    await mount()
    expect(notes()).toBeTruthy()
    expect(notes().style.fontSize).toBe('16px')
  })

  it('prefills the method the caller names (the Inbox row means "call")', async () => {
    await mount({ initialMethod: 'email' })
    expect(tile('Email').getAttribute('aria-checked')).toBe('true')
    expect(byText('Log email')).toBeTruthy()
  })

  it('announces itself as a modal dialog', async () => {
    await mount()
    const dlg = host.querySelector('[role="dialog"]') as HTMLElement
    expect(dlg).toBeTruthy()
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(dlg.getAttribute('aria-label')).toBe('Log touchpoint')
  })

  it('Esc closes it — OverlayShell brings the backdrop and the X, not this', async () => {
    const onClose = vi.fn()
    await mount({ onClose })
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Cancel closes without submitting', async () => {
    const onClose = vi.fn()
    const onSubmit = vi.fn(async () => {})
    await mount({ onClose, onSubmit })
    await act(async () => { byText('Cancel')!.click() })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('a failed submit keeps the modal open with the notes intact (retryable, not retyped)', async () => {
    // The caller closes on a CONFIRMED write; the modal closing itself would
    // eat the typed notes on a 500.
    const onClose = vi.fn()
    const onSubmit = vi.fn(async () => { throw new Error('boom') })
    await mount({ onClose, onSubmit })
    await type(notes(), 'Gate code 4321')
    await act(async () => { byText('Log call')!.click() })
    await act(async () => { await Promise.resolve() })

    expect(onClose).not.toHaveBeenCalled()
    expect(notes().value).toBe('Gate code 4321')
  })

  // ── sizing: compact, square-ish, never chunky (standing preference) ──
  it('footer buttons are compact — ~33px tall, tight padding, NOT full-width slabs', async () => {
    await mount()
    for (const label of ['Cancel', 'Log call']) {
      const b = byText(label)!
      // 8px padding + 13px/1.2 text ≈ 33px. The default-large button (10-12px
      // padding at 15px text) is what this is guarding against.
      expect(b.style.padding, label).toBe('8px 15px')
      expect(b.style.fontSize, label).toBe('13px')
      expect(b.style.width, `${label} must not stretch`).toBe('')
    }
    // right-aligned pair, not a stacked full-bleed column
    const footer = byText('Log call')!.parentElement as HTMLElement
    expect(footer.style.justifyContent).toBe('flex-end')
  })

  it('method tiles are square-ish, and the shell width is what keeps them that way', async () => {
    await mount()
    // The tiles are flex:1 in the content column, so tile width is derived:
    // (shellWidth - 2*24 padding - 3*8 gaps) / 4. Assert the RATIO the width
    // produces — a widened shell silently turns these back into wide bars.
    const shell = 380, pad = 24, gap = 8, n = METHODS.length
    const tileW = (shell - 2 * pad - (n - 1) * gap) / n
    const tileH = parseInt(tile('Call').style.minHeight, 10)
    expect(tileH).toBe(68)
    expect(tileW).toBeCloseTo(77, 0)
    expect(tileW / tileH).toBeGreaterThan(0.8)
    expect(tileW / tileH, 'tiles must stay square-ish, not wide bars').toBeLessThan(1.25)

    const src = readFileSync('components/hive/TouchpointModal.jsx', 'utf8')
    expect(src).toContain('const MODAL_WIDTH = 380')
    expect(src).toContain('maxWidth={MODAL_WIDTH}')
  })

  it('outcome chips are small pills, not tiles', async () => {
    await mount()
    const chip = byText('No answer')!
    expect(chip.style.padding).toBe('5px 11px')
    expect(chip.style.fontSize).toBe('12px')
  })

  it('the shell it composes is OverlayShell — one overlay chrome, not a fourth hand-rolled one', () => {
    const src = readFileSync('components/hive/TouchpointModal.jsx', 'utf8')
    expect(src).toContain("import OverlayShell from './OverlayShell'")
    // and it does NOT write — the surfaces own their own bodies + hand-ups
    expect(src).not.toContain('/api/touchpoints')
  })

  it('the status vocabulary is the one Timeline already renders (no backend needed)', () => {
    expect(OUTCOMES.map(o => o.value)).toEqual(['reached', 'no_answer', 'voicemail'])
    // Timeline de-underscores the raw value — 'no_answer' reads "no answer".
    expect(readFileSync('components/hive/shared/Timeline.jsx', 'utf8')).toMatch(/replace\(\/_\/g, ' '\)/)
  })

  it('method values are the schema’s (touchpoints.method CHECK), not the labels', () => {
    expect(METHODS.map(m => m.value)).toEqual(['call', 'sms', 'email', 'in_person'])
  })
})

// ═══ 2) the input style is single-homed ════════════════════════
describe('form field styles — extracted, not copied a fourth time', () => {
  it('NewClientSheet and the modal both import inp/lbl from shared/formKit (no second copy)', () => {
    const kit = readFileSync('components/hive/shared/formKit.js', 'utf8')
    expect(kit).toContain('export const inp')
    expect(kit).toContain('export const lbl')
    expect(kit).toContain("fontSize: '16px'") // the iOS no-zoom floor lives here now

    for (const f of ['components/hive/NewClientSheet.jsx', 'components/hive/TouchpointModal.jsx']) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).toContain("from './shared/formKit'")
      expect(src, f).not.toMatch(/^const inp = \{/m) // the local copy is gone
    }
  })
})

// ═══ 3) the profile surface, through the real shell ════════════
const profilePayload = (over: any = {}) => ({
  client: {
    id: 'p1', name: 'Sarah Mitchell', first_name: 'Sarah', last_name: 'Mitchell',
    email: 'sarah@email.com', phone: '(561) 555-0199', address: null, city: null, state: null, zip: null,
    created_at: daysAgo(3), source: 'webform', paused: false, marketing_opt_out: false,
    snoozed_until: null, assigned_to: null, assigned_to_name: null,
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    jobber_client_id: null, location_uuid: 'loc-uuid-1', location_id: null,
    paid_amount: 0, request_details: null, project_type: null, location_name: 'Denver',
    ...(over.client || {}),
  },
  referred_us: [], contacts: [], engagements: [], touchpoints: [], buzz_notes: [], job_notes: [],
  tags: [],
  aggregates: { lifetime_paid: 0, invoiced: 0, open_pipeline: 0, owing: 0, open_count: 0, total_count: 0 },
})

// The real row POST /api/touchpoints returns (select('*')).
const touchpointRow = (over: any = {}) => ({
  id: 'tp-profile-1',
  lead_id: 'p1',
  location_uuid: 'loc-uuid-1',
  kind: 'reach_out',
  method: 'call',
  label: 'Reach-out',
  status: null,
  occurred_at: new Date(now).toISOString(),
  engagement_id: null,
  ...over,
})

const PEOPLE = [{
  id: 'p1', name: 'Sarah Mitchell', email: 'sarah@email.com', phone: '(561) 555-0199',
  locationId: 'loc-uuid-1', created: daysAgo(3), isJunk: false, jobberRef: null,
  paidAmount: 0, source: 'webform', outreachTimeline: [],
}]

const lsStore = new Map<string, string>()
const lsMock = {
  getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
  setItem: (k: string, v: string) => { lsStore.set(k, String(v)) },
  removeItem: (k: string) => { lsStore.delete(k) },
  clear: () => { lsStore.clear() },
}

describe('log a touchpoint from the CLIENT PROFILE — the surface that used to tell nobody', () => {
  let container: HTMLDivElement
  let root: Root
  let posts: any[] = []

  beforeEach(() => {
    posts = []
    vi.stubGlobal('localStorage', lsMock)
    lsStore.clear()
    global.fetch = vi.fn(async (url: any, opts: any = {}) => {
      const u = String(url)
      if (u.startsWith('/api/touchpoints') && opts.method === 'POST') {
        const body = JSON.parse(opts.body)
        posts.push(body)
        return { ok: true, status: 201, json: async () => ({ touchpoint: touchpointRow({ notes: body.notes, status: body.status ?? null, method: body.method }) }) } as any
      }
      if (u.includes('/api/clients/p1/profile')) return { ok: true, status: 200, json: async () => profilePayload() } as any
      if (u.startsWith('/api/lookups')) return { ok: true, status: 200, json: async () => ({ lookups: [] }) } as any
      return { ok: true, status: 200, json: async () => ({}) } as any
    }) as any
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    if (root) act(() => root.unmount())
    if (container) container.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const mountWithProfile = async (lens = 'inbox') => {
    localStorage.setItem('bee_hive_beta_lens', lens)
    await act(async () => {
      root.render(<HiveShell people={PEOPLE} engagements={[]} locFilter="loc-uuid-1" urlClientId="p1" />)
    })
    await act(async () => { await Promise.resolve() })
  }

  const text = () => container.textContent || ''
  const byText = (label: string) =>
    Array.from(container.querySelectorAll('button')).find(b => (b.textContent || '').trim() === label)

  const logFromProfile = async (note?: string, outcome?: string) => {
    const open = byText('Log touchpoint')
    expect(open, 'the profile action row should offer Log touchpoint').toBeTruthy()
    await act(async () => { open!.click() })
    if (note) {
      const box = container.querySelector('textarea[aria-label="Notes"]') as HTMLTextAreaElement
      expect(box, 'the modal should expose a notes textarea').toBeTruthy()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      await act(async () => {
        setter.call(box, note)
        box.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    if (outcome) {
      const chip = byText(outcome)
      expect(chip, `outcome chip ${outcome}`).toBeTruthy()
      await act(async () => { chip!.click() })
    }
    const log = byText('Log call')
    expect(log, 'the modal footer should restate the method').toBeTruthy()
    await act(async () => { log!.click() })
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
  }

  it('POSTs the composed body — client-level, no engagement_id, outcome only when picked', async () => {
    await mountWithProfile()
    await logFromProfile('Rang out twice', 'No answer')

    expect(posts).toEqual([{
      lead_id: 'p1', kind: 'reach_out', label: 'Reach-out',
      method: 'call', status: 'no_answer', notes: 'Rang out twice',
    }])
  })

  it('re-derives the person New → Attempting in the Inbox underneath — no reload', async () => {
    // The regression this build closes on THIS surface: the profile wrote a
    // real touchpoint and no lens noticed until a reload.
    await mountWithProfile('inbox')
    expect(text()).toContain('New · 1')
    expect(text()).toContain('Attempting · 0')

    await logFromProfile()

    expect(text()).toContain('New · 0')
    expect(text()).toContain('Attempting · 1')
  })

  it('hands up the RAW server row — the fabricated tmp id could never have deduped', async () => {
    await mountWithProfile()
    await logFromProfile()

    const entry = touchpointToTimelineEntry(touchpointRow())
    expect(entry.id).toBe('tp-profile-1')
    const [after] = mergePeopleTouches(PEOPLE as any, { p1: [entry] })
    expect(deriveClientStatus(after, new Set(), now)).toBe('Attempting')
    expect(text()).toContain('Attempting · 1')
  })

  it('does NOT double-count when the server echoes the same touchpoint back', async () => {
    const entry = touchpointToTimelineEntry(touchpointRow())
    const echoed = [{ ...PEOPLE[0], outreachTimeline: [entry] }]
    const [after] = mergePeopleTouches(echoed as any, { p1: [entry] })

    expect(after.outreachTimeline).toHaveLength(1) // not 2 — the id deduped
    expect(deriveClientStatus(after, new Set(), now)).toBe('Attempting')
  })
})
