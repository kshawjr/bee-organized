// @vitest-environment happy-dom
//
// #112 — two RENDER bugs on the client card, both proven against prod data
// (the DB was correct; only the UI lied):
//
//   1) NotesStream ("Recent activity") dropped the label. The row did
//      `METHOD_LABEL[a.method] || a.label`, and METHOD_LABEL['email'] is
//      truthy, so the meaningful label of a system-authored touchpoint
//      (drip subject, "Drip stopped — email bounced", "Client created")
//      never rendered — you saw the generic channel word instead. Human
//      reach-outs (kind='reach_out') send a PLACEHOLDER label ('Reach-out')
//      with the content in notes, so those must stay method-first, byte-
//      identical.
//
//   2) PreferencesBlock read only leads.paused, so every TERMINAL drip stop
//      (hard_bounce, invalid_recipient, …) — which writes lead_drip_progress
//      alone — rendered "Nurture drips active" with a live Pause button. The
//      panel now takes the effective terminal state off the profile payload:
//      stopped shows the plain reason + guidance and NO button (resume no-ops
//      on a dead sequence); completed is display-only; only a live drip keeps
//      Pause/Activate. There is deliberately NO "Activate anyway" control.
import { describe, it, expect, beforeEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import NotesStream from '@/components/hive/NotesStream'
import PreferencesBlock from '@/components/hive/shared/PreferencesBlock'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

beforeEach(() => { document.body.innerHTML = '' })

const NOW = new Date('2026-07-31T05:00:00Z').getTime()
const TS = '2026-07-31T04:10:53Z'
const noop = () => {}

// ── FIX 1 — NotesStream renders the label for system-authored rows ──────
describe('#112 NotesStream — system-authored touchpoints render their label', () => {
  it('drip touchpoint shows the subject label, not the generic "Email"', async () => {
    const items = [{ t: 'touch', id: 'd1', ts: TS, kind: 'drip', method: 'email', label: 'Thank you for reaching out!', notes: null, user_label: null }]
    const { host, unmount } = await mount(<NotesStream label="Recent activity" items={items} nowMs={NOW} onPost={noop} readOnly />)
    const txt = host.textContent || ''
    expect(txt).toContain('Thank you for reaching out!')
    // the bug rendered the channel word in place of the label
    expect(txt).not.toContain('Email')
    await unmount()
  })

  it('terminal-stop drip touchpoint shows the "Drip stopped — …" trace', async () => {
    const items = [{ t: 'touch', id: 'd2', ts: TS, kind: 'drip', method: 'email', label: 'Drip stopped — email bounced', notes: null, user_label: null }]
    const { host, unmount } = await mount(<NotesStream label="Recent activity" items={items} nowMs={NOW} onPost={noop} readOnly />)
    expect(host.textContent || '').toContain('Drip stopped — email bounced')
    await unmount()
  })

  it('system touchpoint shows its label, not the generic "System"', async () => {
    const items = [{ t: 'touch', id: 's1', ts: TS, kind: 'system', method: 'system', label: 'Client created', notes: null, user_label: null }]
    const { host, unmount } = await mount(<NotesStream label="Recent activity" items={items} nowMs={NOW} onPost={noop} readOnly />)
    const txt = host.textContent || ''
    expect(txt).toContain('Client created')
    expect(txt).not.toContain('System')
    await unmount()
  })

  it('human reach_out is UNCHANGED — method word + notes appended, placeholder label hidden', async () => {
    const items = [
      { t: 'touch', id: 'h1', ts: TS, kind: 'reach_out', method: 'call', label: 'Reach-out', notes: 'Discussed pricing', user_label: 'You' },
      { t: 'touch', id: 'h2', ts: TS, kind: 'reach_out', method: 'email', label: 'Reach-out', notes: 'Sent the quote', user_label: 'You' },
    ]
    const { host, unmount } = await mount(<NotesStream label="Recent activity" items={items} nowMs={NOW} onPost={noop} readOnly />)
    const txt = host.textContent || ''
    expect(txt).toContain('Call — Discussed pricing')
    expect(txt).toContain('Email — Sent the quote')
    // the placeholder label must never surface
    expect(txt).not.toContain('Reach-out')
    await unmount()
  })
})

// ── FIX 2 — PreferencesBlock reflects the true nurture-drip lifecycle ────
const baseClient = { id: 'x', marketing_opt_out: false, snoozed_until: null, snoozed_note: null, paused: false }
const dripButtons = (host: HTMLElement) =>
  [...host.querySelectorAll('button')].filter(b => /Pause|Activate/.test(b.textContent || ''))

describe('#112 PreferencesBlock — nurture-drip state is honest', () => {
  it('STOPPED (hard_bounce): plain reason + guidance, NO Pause/Activate, no raw enum', async () => {
    const client = { ...baseClient, drip_stopped_reason: 'hard_bounce' }
    const { host, unmount } = await mount(<PreferencesBlock client={client} openCount={0} onPatched={noop} setToast={noop} />)
    const txt = host.textContent || ''
    expect(txt).toContain('Nurture drips stopped')
    expect(txt).toContain('email address bounced')      // plain-language reason
    expect(txt).toContain('contact support to restart')  // what-to-do line
    expect(txt).not.toContain('hard_bounce')             // never the raw enum
    expect(txt).not.toContain('Nurture drips active')
    expect(dripButtons(host)).toHaveLength(0)            // no button on a dead sequence
    await unmount()
  })

  it('STOPPED (opted_out): points at the re-subscribe control, still no button', async () => {
    const client = { ...baseClient, drip_stopped_reason: 'opted_out' }
    const { host, unmount } = await mount(<PreferencesBlock client={client} openCount={0} onPatched={noop} setToast={noop} />)
    const txt = host.textContent || ''
    expect(txt).toContain('opted out of marketing')
    expect(txt).toContain('Re-subscribe them above')
    expect(dripButtons(host)).toHaveLength(0)
    await unmount()
  })

  it('STOPPED (unknown reason): falls back to generic copy, no enum leak, no button', async () => {
    const client = { ...baseClient, drip_stopped_reason: 'something_new' }
    const { host, unmount } = await mount(<PreferencesBlock client={client} openCount={0} onPatched={noop} setToast={noop} />)
    const txt = host.textContent || ''
    expect(txt).toContain('nurture emails were stopped')
    expect(txt).not.toContain('something_new')
    expect(dripButtons(host)).toHaveLength(0)
    await unmount()
  })

  it('COMPLETED: display-only "completed", NO Pause/Activate', async () => {
    const client = { ...baseClient, drip_completed: true }
    const { host, unmount } = await mount(<PreferencesBlock client={client} openCount={0} onPatched={noop} setToast={noop} />)
    const txt = host.textContent || ''
    expect(txt).toContain('Nurture drips completed')
    expect(txt).not.toContain('Nurture drips active')
    expect(dripButtons(host)).toHaveLength(0)
    await unmount()
  })

  it('PAUSED: unchanged — "paused" with a live Activate button', async () => {
    const client = { ...baseClient, paused: true }
    const { host, unmount } = await mount(<PreferencesBlock client={client} openCount={0} onPatched={noop} setToast={noop} />)
    const txt = host.textContent || ''
    expect(txt).toContain('Nurture drips paused')
    const btns = dripButtons(host)
    expect(btns).toHaveLength(1)
    expect(btns[0].textContent).toBe('Activate')
    await unmount()
  })

  it('ACTIVE: unchanged — "active" with a live Pause button', async () => {
    const { host, unmount } = await mount(<PreferencesBlock client={baseClient} openCount={0} onPatched={noop} setToast={noop} />)
    const txt = host.textContent || ''
    expect(txt).toContain('Nurture drips active')
    const btns = dripButtons(host)
    expect(btns).toHaveLength(1)
    expect(btns[0].textContent).toBe('Pause')
    await unmount()
  })

  it('a STOPPED drip never offers "Activate anyway" (the decided design)', async () => {
    const client = { ...baseClient, drip_stopped_reason: 'invalid_recipient' }
    const { host, unmount } = await mount(<PreferencesBlock client={client} openCount={0} onPatched={noop} setToast={noop} />)
    expect(host.textContent || '').not.toContain('Activate anyway')
    await unmount()
  })
})

// ── issue 243 — NEVER ENROLLED, the state that used to render as "active" ──
// #112 fixed the false-active class for terminal stops and left the zero-rows
// case behind: a lead that was never enrolled reaches the component with the
// same nulls a healthy live drip carries, so the final else claimed "Nurture
// drips active" and offered to pause a sequence that never started. The route
// now says which it is (drip_never_enrolled); this pins what the panel does
// with that.
describe('#243 PreferencesBlock — never-enrolled reads honestly', () => {
  it('NEVER ENROLLED: says it is not receiving emails, never "active"', async () => {
    const client = { ...baseClient, drip_never_enrolled: true, drip_never_enrolled_reason: null }
    const { host, unmount } = await mount(<PreferencesBlock client={client} openCount={0} onPatched={noop} setToast={noop} />)
    const txt = host.textContent || ''
    expect(txt).toContain('Not receiving nurture emails')
    expect(txt).not.toContain('Nurture drips active')
    await unmount()
  })

  it('NEVER ENROLLED: NO Pause button — there is nothing to pause — but Activate, which starts it', async () => {
    // 2026-09-27 (Kevin): Activate is shown wherever it genuinely starts the
    // drip. drip-resume enrols a no-drip lead at a LIVE location, and if
    // something still stops it the toast names why — so it no longer
    // "silently no-ops". The live-location gate case below keeps no button.
    const client = { ...baseClient, drip_never_enrolled: true, drip_never_enrolled_reason: null }
    const { host, unmount } = await mount(<PreferencesBlock client={client} openCount={0} onPatched={noop} setToast={noop} />)
    expect(dripButtons(host).map(b => b.textContent)).toEqual(['Activate'])
    await unmount()
  })

  it('NEVER ENROLLED: no Activate either — it would re-hit the gate that skipped it', async () => {
    // Same decision #112 made for stopped drips: a control that silently
    // no-ops is worse than no control. drip-resume → startDripForLead walks
    // straight back into the interface-active gate for the dominant reason.
    const client = { ...baseClient, drip_never_enrolled: true, drip_never_enrolled_reason: 'location_not_active' }
    const { host, unmount } = await mount(<PreferencesBlock client={client} openCount={0} onPatched={noop} setToast={noop} />)
    const txt = host.textContent || ''
    expect(txt).not.toContain('Activate anyway')
    expect(dripButtons(host)).toHaveLength(0)
    await unmount()
  })

  it('NEVER ENROLLED (location not active): says WHY, in plain English, no raw enum', async () => {
    const client = { ...baseClient, drip_never_enrolled: true, drip_never_enrolled_reason: 'location_not_active' }
    const { host, unmount } = await mount(<PreferencesBlock client={client} openCount={0} onPatched={noop} setToast={noop} />)
    const txt = host.textContent || ''
    expect(txt).toContain('this location isn’t live yet')
    expect(txt).toContain('once the location is live')
    expect(txt).not.toContain('location_not_active')
    await unmount()
  })

  it('NEVER ENROLLED (arrived pre-activation): its own reason, not the generic one', async () => {
    const client = { ...baseClient, drip_never_enrolled: true, drip_never_enrolled_reason: 'location_activated_later' }
    const { host, unmount } = await mount(<PreferencesBlock client={client} openCount={0} onPatched={noop} setToast={noop} />)
    const txt = host.textContent || ''
    expect(txt).toContain('arrived before the location went live')
    expect(txt).not.toContain('location_activated_later')
    await unmount()
  })

  it('NEVER ENROLLED (reason unknown): headline stands alone, no invented cause', async () => {
    const client = { ...baseClient, drip_never_enrolled: true, drip_never_enrolled_reason: null }
    const { host, unmount } = await mount(<PreferencesBlock client={client} openCount={0} onPatched={noop} setToast={noop} />)
    const txt = host.textContent || ''
    expect(txt).toContain('Not receiving nurture emails')
    // no em-dash clause, and none of the knowable reasons asserted
    expect(txt).not.toContain('this location isn’t live yet')
    expect(txt).not.toContain('arrived before the location went live')
    // 2026-09-27 — no ticket: Activate starts it, and names the cause if not.
    expect(txt).not.toMatch(/contact support/i)
    expect(txt).toContain('Tap Activate to start them')
    await unmount()
  })

  it('PAUSED outranks never-enrolled — an imported lead is BOTH and keeps Activate', async () => {
    // Imported leads land paused=true with zero progress rows. If
    // never-enrolled won here, ~14k of them would lose the one control that
    // actually enrolls them (drip-resume's seed path).
    const client = { ...baseClient, paused: true, drip_never_enrolled: true, drip_never_enrolled_reason: 'location_not_active' }
    const { host, unmount } = await mount(<PreferencesBlock client={client} openCount={0} onPatched={noop} setToast={noop} />)
    const txt = host.textContent || ''
    expect(txt).toContain('Nurture drips paused')
    expect(txt).not.toContain('Not receiving nurture emails')
    const btns = dripButtons(host)
    expect(btns).toHaveLength(1)
    expect(btns[0].textContent).toBe('Activate')
    await unmount()
  })

  it('STOPPED outranks never-enrolled — the #112 reason still wins', async () => {
    const client = { ...baseClient, drip_stopped_reason: 'hard_bounce', drip_never_enrolled: true }
    const { host, unmount } = await mount(<PreferencesBlock client={client} openCount={0} onPatched={noop} setToast={noop} />)
    const txt = host.textContent || ''
    expect(txt).toContain('Nurture drips stopped')
    expect(txt).toContain('email address bounced')
    expect(txt).not.toContain('Not receiving nurture emails')
    await unmount()
  })

  it('a LIVE drip is untouched — "active" with Pause, when the route says not-never-enrolled', async () => {
    const client = { ...baseClient, drip_never_enrolled: false, drip_never_enrolled_reason: null }
    const { host, unmount } = await mount(<PreferencesBlock client={client} openCount={0} onPatched={noop} setToast={noop} />)
    const txt = host.textContent || ''
    expect(txt).toContain('Nurture drips active')
    expect(txt).not.toContain('Not receiving nurture emails')
    const btns = dripButtons(host)
    expect(btns).toHaveLength(1)
    expect(btns[0].textContent).toBe('Pause')
    await unmount()
  })

  it('live business still hides the whole row (v4 rule) even when never-enrolled', async () => {
    const client = { ...baseClient, drip_never_enrolled: true, drip_never_enrolled_reason: 'location_not_active' }
    const { host, unmount } = await mount(<PreferencesBlock client={client} openCount={2} onPatched={noop} setToast={noop} />)
    const txt = host.textContent || ''
    expect(txt).not.toContain('Not receiving nurture emails')
    expect(txt).not.toContain('Nurture drips')
    await unmount()
  })
})

// ── 2026-09-27 — EVERY NEVER-ENROLLED CAUSE NAMED, ACTIVATE WHERE IT WORKS ──
// startDripForLead now records WHY it didn't enrol; the profile route passes
// the code through (drip_never_enrolled_reason) plus the sequence the lead
// would use (drip_enrol_sequence). The card names each cause in the owner's
// words, offers Activate wherever drip-resume would genuinely start the drip,
// and never sends the owner to "contact support" for any of them.
import { DRIP_NEVER_COPY, DRIP_NEVER_FALLBACK, dripNeverReasonText } from '@/components/hive/shared/PreferencesBlock'

describe('2026-09-27 PreferencesBlock — each cause named, Activate where it works', () => {
  const cases: [string, string | null, string, boolean][] = [
    // reason code,              sequence,  words on the card,                                     Activate?
    ['drip_not_ticked',          null,      'Drip wasn’t ticked when this client was added',         true],
    ['location_activated_later', null,      'arrived before the location went live',                 true],
    ['location_not_active',      null,      'this location isn’t live yet',                           false],
    ['path_has_no_first_email',  'Moving',  'your Moving sequence has no first email',                true],
    ['no_default_path',          'Organizing', 'no Organizing sequence is chosen',                    true],
    ['path_missing',             'Moving',  'your Moving sequence can’t be found',                    true],
    ['lookup_failed',            null,      'a temporary error stopped them starting',                true],
  ]
  for (const [reason, sequence, words, activate] of cases) {
    it(`${reason}: names the cause${activate ? ' and offers Activate' : ', no Activate (it would hit the same gate)'}`, async () => {
      const client = { ...baseClient, drip_never_enrolled: true, drip_never_enrolled_reason: reason, drip_enrol_sequence: sequence }
      const { host, unmount } = await mount(<PreferencesBlock client={client} openCount={0} onPatched={noop} setToast={noop} />)
      const txt = host.textContent || ''
      expect(txt).toContain(words)
      expect(txt).not.toContain(reason) // never the raw code
      expect(txt).not.toMatch(/contact support/i)
      expect(dripButtons(host).map(b => b.textContent)).toEqual(activate ? ['Activate'] : [])
      await unmount()
    })
  }

  it('the setup causes point at Settings → Emails, the place the owner fixes them', () => {
    for (const r of ['path_has_no_first_email', 'no_default_path', 'path_missing']) {
      expect((DRIP_NEVER_COPY as any)[r].guide).toContain('Settings → Emails')
    }
  })

  it('NO never-enrolled message says "contact support" — every cause is by design or owner-fixable', () => {
    const all = [...Object.values(DRIP_NEVER_COPY), DRIP_NEVER_FALLBACK] as any[]
    for (const copy of all) {
      const reasonText = dripNeverReasonText(copy, 'Moving') || ''
      expect(`${reasonText} ${copy.guide}`).not.toMatch(/contact support/i)
    }
  })

  it('Activate that still can’t start the drip says WHY, instead of toasting "active"', async () => {
    const toasts: any[] = []
    const patches: any[] = []
    const realFetch = globalThis.fetch
    ;(globalThis as any).fetch = async () => ({
      ok: true,
      json: async () => ({ ok: true, enrolled: false, reason: 'path_has_no_first_email', message: 'the Moving sequence has no emails in it — add one in Settings → Emails' }),
    })
    try {
      const client = { ...baseClient, drip_never_enrolled: true, drip_never_enrolled_reason: 'drip_not_ticked' }
      const { host, unmount } = await mount(<PreferencesBlock client={client} openCount={0} onPatched={(p: any) => patches.push(p)} setToast={(t: any) => toasts.push(t)} />)
      await act(async () => { dripButtons(host)[0].click() })
      expect(toasts).toEqual([{ kind: 'error', msg: 'Nurture emails didn’t start: the Moving sequence has no emails in it — add one in Settings → Emails' }])
      expect(patches[0]).toMatchObject({ drip_never_enrolled: true, drip_never_enrolled_reason: 'path_has_no_first_email' })
      await unmount()
    } finally {
      ;(globalThis as any).fetch = realFetch
    }
  })

  it('Activate that DOES start it flips the card to active', async () => {
    const patches: any[] = []
    const toasts: any[] = []
    const realFetch = globalThis.fetch
    ;(globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ ok: true, enrolled: true }) })
    try {
      const client = { ...baseClient, drip_never_enrolled: true, drip_never_enrolled_reason: 'drip_not_ticked' }
      const { host, unmount } = await mount(<PreferencesBlock client={client} openCount={0} onPatched={(p: any) => patches.push(p)} setToast={(t: any) => toasts.push(t)} />)
      await act(async () => { dripButtons(host)[0].click() })
      expect(patches[0]).toEqual({ paused: false, drip_never_enrolled: false, drip_never_enrolled_reason: null })
      expect(toasts[0]).toEqual({ kind: 'success', msg: 'Nurture drips active' })
      await unmount()
    } finally {
      ;(globalThis as any).fetch = realFetch
    }
  })
})

// ── the New sheet warns at creation time ──
import { readFileSync as readSrc } from 'node:fs'
import { join as joinPath } from 'node:path'
import { dripNotStartedToast } from '@/components/hive/NewClientSheet'

describe('2026-09-27 New sheet — "Client saved — nurture emails didn’t start: <reason>"', () => {
  it('the warning text', () => {
    expect(dripNotStartedToast({ enrolled: false, reason: 'drip_not_ticked', message: 'Drip wasn’t ticked when this client was added' }))
      .toBe('Client saved — nurture emails didn’t start: Drip wasn’t ticked when this client was added.')
  })
  it('createPerson shows it when the route reports the drip didn’t start — and only then', () => {
    const src = readSrc(joinPath(process.cwd(), 'components/hive/NewClientSheet.jsx'), 'utf8')
    expect(src).toContain('const { lead, drip } = await postLead({')
    expect(src).toMatch(/if \(drip && drip\.enrolled === false\) \{\s*setToast\(\{ kind: 'error', msg: dripNotStartedToast\(drip\) \}\)/)
  })
})
