// components/settings/TeamAndLeads.jsx
// ─────────────────────────────────────────────────────────────
// Settings → Team and leads — slice 2 of 4 of the Settings rebuild
// (2026-11-13, the export's `Team` page in src/components/settings/pages.tsx).
//
// The export's page is today's Team and Seats with the New leads section
// folded into it: the "New lead emails" switch sits under each person who
// signs in, so the separate Notifications › New leads section stops being
// needed and retires.
//
// This file holds two things and decides nothing about who may see them:
//
//   useLeadRecipients(locId)  — who is told about a new lead. The SAME five
//     requests NewLeadsSection (BeeHub.jsx) made for its "who is told" list,
//     address for address and body for body; lib/team-and-leads.test.tsx
//     holds the two equal. NewLeadsSection itself is untouched: it still
//     draws "who handles what" on Settings → Emails.
//
//   the rows — a person who signs in, an open seat, an outside address, the
//     payment banner, the billing row. Drawn from what they are handed.
//
// WHO sees the Seats half (owner only) and every seat, invite and billing
// call stay in BeeHub.jsx (SettingsScreen's canSeeSeats, TeamSection). The
// Bees half is components/hive/BeeRosterSettings.jsx, restyled in place.
//
// What the export does NOT draw and this keeps, because an owner uses it:
//   · an outside address can be MUTED, not only removed (the switch on its
//     row) — see toggleExternal below for why removing is not enough
//   · "N told about new leads", beside the add action
//   · "Handles Moving…" and the owner's fallback note under a switch
//   · the line saying Slack posts every lead whatever is set here
// ─────────────────────────────────────────────────────────────
'use client'

import React from 'react'
import { T, R, FONT } from '@/components/design/tokens'
import { displayPhone } from '@/lib/phone'
import {
  Pill, Btn, IconBtn, Switch, Avatar, Notice, Field,
  IconChevronRight, IconTrash, IconCard, IconMail, IconAlertTriangle,
} from '@/components/settings/SettingsShell'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const LOAD_FAILED = 'Could not load who is told about new leads. Reload the page to try again.'
const SAVE_FAILED = 'That did not save. Try again.'

// ── Who is told about a new lead ──────────────────────────────────────────
// Two lists, one switch each:
//   people who sign in   lead_notification_prefs.subscribed
//   outside addresses    lead_notification_externals.subscribed
// plus the job-type handlers, read only, for the "Handles …" note.
export function useLeadRecipients(locId) {
  const [handlers, setHandlers] = React.useState(null)
  const [notif, setNotif] = React.useState(null)
  const [busy, setBusy] = React.useState(null)
  const [err, setErr] = React.useState('')

  // `afterFailedSave` re-reads the lists to put the screen back to what is
  // stored, and must NOT clear the sentence that says the save failed. (The
  // New leads section cleared it here, so a refused save snapped the switch
  // back without a word.)
  const load = React.useCallback(async (afterFailedSave = false) => {
    if (!locId) return
    try {
      const [hRes, nRes] = await Promise.all([
        fetch(`/api/locations/${locId}/project-type-senders`, { credentials:'include' }),
        fetch(`/api/locations/${locId}/notification-recipients`, { credentials:'include' }),
      ])
      if (hRes.ok) setHandlers(await hRes.json())
      if (nRes.ok) setNotif(await nRes.json())
      if (!hRes.ok || !nRes.ok) setErr(LOAD_FAILED)
      else if (!afterFailedSave) setErr('')
    } catch {
      setErr(LOAD_FAILED)
    }
  }, [locId])
  React.useEffect(() => { load() }, [load])

  async function toggleUser(u) {
    setBusy(`u:${u.hub_user_id}`); setErr('')
    const next = !u.subscribed
    setNotif(n => ({ ...n, users: n.users.map(x => x.hub_user_id===u.hub_user_id ? { ...x, subscribed: next } : x) }))
    try {
      const res = await fetch(`/api/locations/${locId}/notification-recipients`, {
        method:'PATCH', credentials:'include', headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ hub_user_id: u.hub_user_id, subscribed: next }),
      })
      if (!res.ok) throw new Error()
    } catch { setErr(SAVE_FAILED); await load(true) } finally { setBusy(null) }
  }

  // MUTE, NOT DELETE. Before lead_notification_externals.subscribed existed the
  // only way to stop an outside address was to remove the row — which lost the
  // record AND let the nightly Zoho recipient top-up add the address straight
  // back the next morning. Removing is still offered, separately, for an
  // address that genuinely does not belong on the list.
  async function toggleExternal(e) {
    setBusy(`e:${e.id}`); setErr('')
    const next = !e.subscribed
    setNotif(n => ({ ...n, externals: n.externals.map(x => x.id===e.id ? { ...x, subscribed: next } : x) }))
    try {
      const res = await fetch(`/api/locations/${locId}/notification-recipients/externals/${e.id}`, {
        method:'PATCH', credentials:'include', headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ subscribed: next }),
      })
      if (!res.ok) throw new Error()
    } catch { setErr(SAVE_FAILED); await load(true) } finally { setBusy(null) }
  }

  async function removeExternal(id) {
    setBusy(`e:${id}`); setErr('')
    setNotif(n => ({ ...n, externals: n.externals.filter(x => x.id !== id) }))
    try {
      const res = await fetch(`/api/locations/${locId}/notification-recipients/externals/${id}`, {
        method:'DELETE', credentials:'include',
      })
      if (!res.ok) throw new Error()
    } catch { setErr(SAVE_FAILED); await load(true) } finally { setBusy(null) }
  }

  // Answers '' when the address was added, or the sentence to show.
  async function addExternal(form) {
    const email = (form.email || '').trim()
    if (!EMAIL_RE.test(email)) return 'Enter a valid email address.'
    try {
      const res = await fetch(`/api/locations/${locId}/notification-recipients`, {
        method:'POST', credentials:'include', headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({
          first_name: (form.first_name || '').trim() || null,
          last_name: (form.last_name || '').trim() || null,
          email, phone: (form.phone || '').trim() || null,
        }),
      })
      if (!res.ok) return 'Could not add that address.'
      await load()
      return ''
    } catch { return 'Could not add that address.' }
  }

  const users = notif?.users || []
  const externals = notif?.externals || []
  const assignments = handlers?.assignments || []
  return {
    hasLocation: !!locId,
    ready: !!notif,
    users, externals, busy, err,
    // Which job types this person handles — an owner switching off someone
    // who handles Moving should see that before they do it.
    typesHandledBy: hubUserId => assignments.filter(a => a.source_user_id === hubUserId).map(a => a.project_type),
    toldCount: users.filter(u => u.subscribed).length + externals.filter(e => e.subscribed).length,
    toggleUser, toggleExternal, removeExternal, addExternal,
  }
}

// The roster (hub_users.id) and the recipients list (hub_user_id) are two
// reads of the same people. Matched by id, then by email as a fallback.
export function recipientFor(leads, user) {
  if (!leads?.ready || !user) return null
  const email = String(user.email || '').trim().toLowerCase()
  return leads.users.find(r => r.hub_user_id === user.id)
    || (email ? leads.users.find(r => String(r.email || '').trim().toLowerCase() === email) : null)
    || null
}

const nameStyle = { display:'block', fontSize:'14px', lineHeight:'20px', fontWeight:700, color:T.foreground, overflowWrap:'anywhere' }
// A long address WRAPS. It is never cut with "…": an owner has to be able to
// read the whole of it on a phone.
const emailStyle = { display:'block', fontSize:'12px', lineHeight:'18px', color:T.mutedFg, overflowWrap:'anywhere' }
const subLabel = { fontSize:'11px', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.14em', color:T.mutedFg }

// ── The "New lead emails" line under a person ─────────────────────────────
function LeadLine({ on, busy, onToggle, switchLabel, children }) {
  return (
    <div data-slead>
      <div style={{ flex:1, minWidth:0 }}>
        <p style={{ fontSize:'14px', lineHeight:'20px', fontWeight:700, color:T.foreground }}>New lead emails</p>
        {children}
      </div>
      <Switch on={on} disabled={busy} onClick={onToggle} label={switchLabel} />
    </div>
  )
}
const leadNote = { marginTop:'2px', fontSize:'12px', lineHeight:'18px', color:T.mutedFg }

// ── A person who signs in ─────────────────────────────────────────────────
// `onOpen` opens their detail sheet (role, Jobber link, remove access); a row
// without it is not a button. `recipient` is their entry in the told list, or
// null while that list is loading or when they are not on it.
export function SeatRow({ user, chips, onOpen, recipient, leads }) {
  const handled = recipient ? leads.typesHandledBy(recipient.hub_user_id) : []
  const who = (
    <>
      <Avatar name={user.name} quiet={!!user.disabled} />
      <span style={{ minWidth:0 }}>
        <span data-seat-name style={nameStyle}>{user.name}</span>
        {user.email && <span data-seat-email style={emailStyle}>{user.email}</span>}
        {chips && <span style={{ display:'flex', flexWrap:'wrap', gap:'6px', marginTop:'4px' }}>{chips}</span>}
      </span>
    </>
  )
  const grid = { display:'grid', gridTemplateColumns:'auto minmax(0,1fr) auto', alignItems:'center', gap:'12px', width:'100%' }
  return (
    <div data-seat={user.email || user.id} style={{ padding:'12px 0', display:'flex', flexDirection:'column', gap:'4px' }}>
      {onOpen ? (
        <button type="button" data-seat-open data-sbtn="row" onClick={onOpen} aria-label={`Manage ${user.name}`}
          style={{ ...grid, minHeight:'44px', padding:0, border:'none', background:'transparent', cursor:'pointer', fontFamily:FONT.ui, textAlign:'left' }}>
          {who}
          <span aria-hidden="true" style={{ display:'flex', color:T.mutedFg }}><IconChevronRight size={16} style={{ verticalAlign:0 }} /></span>
        </button>
      ) : (
        <div style={grid}>{who}</div>
      )}
      {recipient && (
        <LeadLine on={recipient.subscribed} busy={leads.busy === `u:${recipient.hub_user_id}`}
          onToggle={() => leads.toggleUser(recipient)} switchLabel={`Tell ${recipient.name} about new leads`}>
          {/* Shown whether the switch is on or off. Since 2026-08-30 the
              person a lead is assigned to is ALWAYS emailed, so switching a
              handler off narrows them to their own leads; it cannot silence
              them. */}
          {handled.length > 0 && (
            <p data-handles={recipient.email} style={leadNote}>
              Handles {handled.join(', ')}
              {!recipient.subscribed && <span style={{ color:T.warning }}> — still emailed about these; the switch only covers other leads</span>}
            </p>
          )}
          {recipient.role === 'owner' && !recipient.subscribed && (
            <p data-owner-note={recipient.email} style={{ ...leadNote, color:T.warning }}>
              Any lead without a handler is assigned to the owner — those still email {String(recipient.name || '').split(' ')[0]}
            </p>
          )}
        </LeadLine>
      )}
    </div>
  )
}

// ── A paid seat nobody sits in ────────────────────────────────────────────
export function OpenSeatRow({ tierName, canInvite, onInvite, ...rest }) {
  return (
    <div {...rest} style={{ display:'grid', gridTemplateColumns:'auto minmax(0,1fr) auto', alignItems:'center', gap:'12px', padding:'12px 0' }}>
      <Avatar dashed>{canInvite ? '+' : <IconMail size={16} />}</Avatar>
      <span style={{ minWidth:0 }}>
        <span style={{ ...nameStyle, color:T.mutedFg }}>Open {tierName} seat</span>
        <span style={{ ...emailStyle, color: canInvite ? T.mutedFg : T.warning }}>
          {canInvite ? 'Paid for and ready — invite someone to fill it' : 'Held by an invitation that hasn’t been accepted yet'}
        </span>
      </span>
      {canInvite
        ? <Btn onClick={onInvite}>Invite</Btn>
        : <Pill tone="warn">Invite pending</Pill>}
    </div>
  )
}

// ── Outside addresses, the counter and the add action ─────────────────────
// Each address has the same switch a person has (that is the MUTE) and a bin
// (that is remove, for an address that does not belong on the list at all).
export function OutsideEmails({ leads }) {
  const [adding, setAdding] = React.useState(false)
  const [form, setForm] = React.useState({ first_name:'', last_name:'', email:'', phone:'' })
  const [formErr, setFormErr] = React.useState('')
  const [addBusy, setAddBusy] = React.useState(false)
  const set = key => ev => { setForm(f => ({ ...f, [key]: ev.target.value })); if (key === 'email') setFormErr('') }

  async function submit(ev) {
    ev.preventDefault()
    setAddBusy(true)
    const problem = await leads.addExternal(form)
    setAddBusy(false)
    if (problem) { setFormErr(problem); return }
    setForm({ first_name:'', last_name:'', email:'', phone:'' }); setFormErr(''); setAdding(false)
  }

  if (!leads.hasLocation) {
    return <p data-outside-unavailable style={{ ...leadNote, padding:'12px 0 0' }}>New-lead settings become available once your location is saved.</p>
  }
  return (
    <div data-outside style={{ paddingTop:'12px' }}>
      {leads.err && <Notice tone="danger" role="alert" data-leads-error>{leads.err}</Notice>}

      {leads.externals.length > 0 && (
        <>
          <p style={{ ...subLabel, margin:'8px 0 0' }}>Outside emails</p>
          <div data-slist>
            {leads.externals.map(e => (
              <div key={e.id} data-outside-email={e.email} data-muted={e.subscribed ? undefined : ''}
                style={{ display:'grid', gridTemplateColumns:'auto minmax(0,1fr) auto auto', alignItems:'center', gap:'8px', padding:'8px 0' }}>
                <Avatar quiet><IconMail size={16} /></Avatar>
                <span style={{ minWidth:0, opacity: e.subscribed ? 1 : 0.6 }}>
                  {e.name && e.name !== e.email && <span style={nameStyle}>{e.name}</span>}
                  <span style={{ ...emailStyle, color: e.name && e.name !== e.email ? T.mutedFg : T.foreground, fontSize: e.name && e.name !== e.email ? '12px' : '13px' }}>{e.email}</span>
                  {e.phone && <span style={emailStyle}>{displayPhone(e.phone)}</span>}
                  {!e.subscribed && <span style={{ display:'block', marginTop:'4px' }}><Pill tone="warn">Muted — not emailed</Pill></span>}
                </span>
                <Switch on={e.subscribed} disabled={leads.busy === `e:${e.id}`} onClick={() => leads.toggleExternal(e)}
                  label={`Tell ${e.email} about new leads`} />
                <IconBtn danger label={`Remove ${e.email}`} title="Remove this address from the list entirely"
                  disabled={leads.busy === `e:${e.id}`} onClick={() => leads.removeExternal(e.id)}>
                  <IconTrash size={16} />
                </IconBtn>
              </div>
            ))}
          </div>
        </>
      )}

      {adding ? (
        <form data-outside-add onSubmit={submit} noValidate
          style={{ marginTop:'8px', borderRadius:R.xl, background:T.muted, padding:'16px', display:'flex', flexDirection:'column', gap:'12px' }}>
          <div data-sfields>
            <Field label="First name" value={form.first_name} onChange={set('first_name')} />
            <Field label="Last name" value={form.last_name} onChange={set('last_name')} />
          </div>
          <div data-sfields>
            <Field label="Email" type="email" autoFocus value={form.email} onChange={set('email')} placeholder="email@example.com"
              aria-invalid={formErr ? true : undefined} style={formErr ? { borderColor:T.destructive } : undefined} />
            <Field label="Phone (optional)" type="tel" value={form.phone} onChange={set('phone')} />
          </div>
          {formErr && <p role="alert" style={{ fontSize:'13px', lineHeight:'18px', color:T.destructive }}>{formErr}</p>}
          <p style={leadNote}>Outside addresses are told about new leads only. They never handle a job type and never send client emails.</p>
          <div data-sactions>
            <Btn variant="primary" type="submit" disabled={addBusy}>{addBusy ? 'Adding…' : 'Add email'}</Btn>
            <Btn onClick={() => { setAdding(false); setFormErr('') }}>Cancel</Btn>
          </div>
        </form>
      ) : (
        <div style={{ display:'flex', flexWrap:'wrap', alignItems:'center', justifyContent:'space-between', columnGap:'16px' }}>
          <Btn variant="text" data-outside-add-open onClick={() => setAdding(true)}>+ Add outside email for new leads</Btn>
          {leads.ready && <span data-told-count style={{ fontSize:'13px', lineHeight:'18px', color:T.mutedFg }}>{leads.toldCount} told about new leads</span>}
        </div>
      )}

      {/* Slack is a CHANNEL: the app posts there and everyone in it sees the
          lead, so there is nothing to set per person. Saying so here is the
          honest version of a switch that could not work. */}
      <p data-leads-slack style={{ ...leadNote, marginTop:'4px' }}>
        If your Slack channel is connected, every new lead posts there too, whatever is set here. Connect or disconnect it under Connections › Slack.
      </p>
    </div>
  )
}

// ── The payment strip at the top ──────────────────────────────────────────
const BANNER = { success:T.success, corporate:T.corporate, warning:T.warning }
export function PaymentBanner({ tone = 'success', title, body, action, warning }) {
  const c = BANNER[tone] || BANNER.success
  return (
    <div data-payment-banner style={{ borderRadius:R.xxl, border:`1px solid ${T.border}`, borderLeft:`4px solid ${c}`, background:T.card, padding:'20px' }}>
      <p style={{ fontSize:'11px', lineHeight:'16px', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.14em', color:c }}>{title}</p>
      <p style={{ marginTop:'4px', fontSize:'14px', lineHeight:'20px', color:T.foreground }}>{body}</p>
      {action && <div style={{ marginTop:'12px' }}>{action}</div>}
      {warning && (
        <p style={{ display:'flex', gap:'8px', marginTop:'12px', borderRadius:R.md, background:T.warningSoft, padding:'12px', fontSize:'13px', lineHeight:1.5, color:T.warning }}>
          <IconAlertTriangle size={16} style={{ marginTop:'2px' }} /><span style={{ minWidth:0 }}>{warning}</span>
        </p>
      )}
    </div>
  )
}

// ── "Billing & seat details" ──────────────────────────────────────────────
export function BillingRow({ open, onToggle }) {
  return (
    <button type="button" data-billing-row data-sbtn="outline" onClick={onToggle} aria-expanded={open}
      style={{ display:'flex', alignItems:'center', gap:'12px', width:'100%', minHeight:'44px', marginTop:'12px', padding:'12px 16px', borderRadius:R.xl, border:'none', background:T.muted, cursor:'pointer', fontFamily:FONT.ui, textAlign:'left' }}>
      <span aria-hidden="true" style={{ display:'flex', color:T.gold }}><IconCard size={16} /></span>
      <span style={{ flex:1, minWidth:0, fontSize:'14px', lineHeight:'20px', fontWeight:700, color:T.foreground }}>Billing &amp; seat details</span>
      <span aria-hidden="true" style={{ display:'flex', color:T.mutedFg, transform: open ? 'rotate(90deg)' : 'none', transition:'transform .15s' }}><IconChevronRight size={16} style={{ verticalAlign:0 }} /></span>
    </button>
  )
}
