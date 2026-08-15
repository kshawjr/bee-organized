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

  it('NEVER ENROLLED: NO Pause button — there is nothing to pause', async () => {
    const client = { ...baseClient, drip_never_enrolled: true, drip_never_enrolled_reason: null }
    const { host, unmount } = await mount(<PreferencesBlock client={client} openCount={0} onPatched={noop} setToast={noop} />)
    expect(dripButtons(host)).toHaveLength(0)
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
    expect(txt).toContain('once the location is activated')
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
    expect(txt).toContain('Contact support to start nurture emails')
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
