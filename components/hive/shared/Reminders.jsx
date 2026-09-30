// components/hive/shared/Reminders.jsx
// ─────────────────────────────────────────────────────────────
// Reminders — a date and a note, on any record, in one list.
//
// Every piece of the feature's UI lives here so the four records, Home and
// the Reminders page cannot drift apart:
//
//   useRecordReminder + RecordReminderList / ReminderBarButton /
//                     ReminderSetterPanel / reminderMenuItem — the record
//                     half: your reminder under the name, the gold bell in
//                     the card's action bar, and "Set a reminder" in the ···
//                     menu, all driving one setter (see below).
//   ReminderSetter  — the three-tap setter: Tomorrow / Next week / Pick a
//                     date, a line saying why, Done. The pencil reuses it.
//   ReminderRow     — one reminder with tick (finish), pencil (change the
//                     date) and X (delete). Used by the record strip, Home
//                     and the Reminders page.
//   useMyReminders  — load / finish / change / delete against /api/reminders.
//
// Deliberately small (Kevin, 2026-09-30): owners are 55+ and not technical.
// No priority, category, assignee, repeat, sub-tasks, time of day, or alert
// of any kind. Nothing here sends anything — a reminder appears on Home on
// its day and goes amber when missed, and that is all.
//
// A reminder belongs to whoever set it. The server stamps the owner; nothing
// in this file sends or chooses one.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { IconBell, IconCheck, IconPencil, IconX } from '@/components/ui/icons'
import { T } from './tokens'
import { quickDates, todayYmd, dueLabel, dueState, sortReminders, REMINDER_NOTE_MAX } from '@/lib/reminders'

// ── data ─────────────────────────────────────────────────────

async function readJson(res) {
  try { return await res.json() } catch { return null }
}

// query: '' for all of mine, or e.g. 'lead_id=<uuid>' for one record.
export function useMyReminders(query = '', { enabled = true } = {}) {
  const [reminders, setReminders] = useState(null) // null = loading
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/reminders${query ? `?${query}` : ''}`, { cache: 'no-store' })
      const json = await readJson(res)
      if (!res.ok) throw new Error(json?.error || 'load_failed')
      setReminders(sortReminders(json?.reminders || []))
      setError(null)
    } catch (e) {
      setError(e.message || 'load_failed')
      setReminders(prev => prev || [])
    }
  }, [query])

  useEffect(() => { if (enabled) load() }, [enabled, load])

  const create = useCallback(async (body) => {
    const reminder = await createReminder(body)
    setReminders(prev => sortReminders([...(prev || []), reminder]))
    return reminder
  }, [])

  const change = useCallback(async (id, patch) => {
    const res = await fetch(`/api/reminders/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    })
    const json = await readJson(res)
    if (!res.ok) throw new Error(json?.error || 'save_failed')
    setReminders(prev => {
      const list = (prev || []).filter(r => r.id !== id)
      // Finished ones leave every list.
      return json?.reminder && !json.reminder.done_at ? sortReminders([...list, json.reminder]) : list
    })
  }, [])

  const remove = useCallback(async (id) => {
    const res = await fetch(`/api/reminders/${id}`, { method: 'DELETE' })
    if (!res.ok) throw new Error((await readJson(res))?.error || 'delete_failed')
    setReminders(prev => (prev || []).filter(r => r.id !== id))
  }, [])

  return {
    reminders, error, reload: load, create,
    finish: (id) => change(id, { done: true }),
    reschedule: (id, due_on, note) => change(id, note != null ? { due_on, note } : { due_on }),
    remove,
  }
}

// ── the setter ───────────────────────────────────────────────

const chip = (on) => ({
  padding: '10px 14px', minHeight: '44px', borderRadius: T.radius.control,
  border: on ? `1.5px solid ${T.accent.fg}` : T.border.control,
  background: on ? T.accent.soft : T.surface.raised,
  color: on ? T.accent.deep : T.ink.primary,
  fontSize: '15px', fontWeight: on ? 600 : 500, cursor: 'pointer', fontFamily: 'inherit',
})

// The date choice + the line, as CONTROLLED fields — the one piece every
// place that sets a reminder shares (the Reminder setter below, and the
// lost-lead wizard's "Set a reminder to follow up later?"). Owners learn
// Tomorrow / Next week / Pick a date once.
export function ReminderFields({ date, note, onDate, onNote, now = new Date(), onEnter = null, autoFocusNote = false }) {
  const { tomorrow, nextWeek } = quickDates(now)
  const [picking, setPicking] = useState(!!date && date !== tomorrow && date !== nextWeek)
  return (
    <>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <button type="button" style={chip(!picking && date === tomorrow)} onClick={() => { setPicking(false); onDate(tomorrow) }}>Tomorrow</button>
        <button type="button" style={chip(!picking && date === nextWeek)} onClick={() => { setPicking(false); onDate(nextWeek) }}>Next week</button>
        <button type="button" style={chip(picking)} onClick={() => { setPicking(true); if (date === tomorrow || date === nextWeek) onDate('') }}>Pick a date</button>
      </div>
      {picking && (
        <input type="date" aria-label="Reminder date" value={date} min={todayYmd(now)} onChange={e => onDate(e.target.value)}
          style={{ padding: '10px 12px', border: T.border.control, borderRadius: T.radius.control, fontSize: '16px', fontFamily: 'inherit', color: T.ink.primary, background: T.surface.raised, alignSelf: 'flex-start' }} />
      )}
      <input aria-label="What is this reminder for?" placeholder="What for? e.g. call about the garage" autoFocus={autoFocusNote}
        value={note} maxLength={REMINDER_NOTE_MAX} onChange={e => onNote(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && onEnter) onEnter() }}
        style={{ padding: '10px 12px', border: T.border.control, borderRadius: T.radius.control, fontSize: '16px', fontFamily: 'inherit', color: T.ink.primary, background: T.surface.raised }} />
    </>
  )
}

// Set one reminder (the same POST the Reminder button makes). The server
// stamps the owner — whoever is signed in — so nothing here names one.
export async function createReminder(body) {
  const res = await fetch('/api/reminders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const json = await readJson(res)
  if (!res.ok || !json?.reminder) throw new Error(json?.error || 'save_failed')
  return json.reminder
}

// Three taps: pick when, say why, Done. `initial` pre-fills for the pencil.
export function ReminderSetter({ initial = null, onDone, onCancel, now = new Date(), saving = false }) {
  const [date, setDate] = useState(initial?.due_on || '')
  const [note, setNote] = useState(initial?.note || '')
  const ready = !!date && note.trim().length > 0 && !saving

  return (
    <div data-testid="reminder-setter" style={{ display: 'flex', flexDirection: 'column', gap: '10px', background: T.surface.sunken, borderRadius: T.radius.inset, padding: '12px' }}>
      <ReminderFields date={date} note={note} onDate={setDate} onNote={setNote} now={now}
        onEnter={() => { if (ready) onDone(date, note.trim()) }} />
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel}
          style={{ padding: '10px 16px', minHeight: '44px', border: 'none', background: 'transparent', color: T.ink.muted, fontSize: '15px', cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
        <button type="button" disabled={!ready} onClick={() => onDone(date, note.trim())}
          style={{ padding: '10px 20px', minHeight: '44px', border: 'none', borderRadius: T.radius.control, background: ready ? T.accent.fg : T.surface.hover, color: ready ? T.accent.onFill : T.ink.disabled, fontSize: '15px', fontWeight: 600, cursor: ready ? 'pointer' : 'not-allowed', fontFamily: 'inherit' }}>
          {saving ? 'Saving…' : 'Done'}
        </button>
      </div>
    </div>
  )
}

// ── one reminder ─────────────────────────────────────────────

const iconBtn = {
  width: '40px', height: '40px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  border: 'none', background: 'transparent', color: T.ink.muted, cursor: 'pointer', borderRadius: T.radius.control, padding: 0, flexShrink: 0,
}

// showName: the person it is about (Home + the Reminders page). On a record
// the record IS the person, so it reads "Reminder: <note>" instead.
export function ReminderRow({ reminder, today, showName = false, onOpen = null, onFinish, onReschedule, onDelete, now = new Date() }) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const state = dueState(reminder.due_on, today)
  const late = state === 'overdue'
  const when = dueLabel(reminder.due_on, today)

  const run = async (fn) => {
    setBusy(true); setFailed(false)
    try { await fn() } catch { setFailed(true) } finally { setBusy(false) }
  }

  if (editing) {
    return (
      <ReminderSetter initial={reminder} now={now} saving={busy}
        onCancel={() => setEditing(false)}
        onDone={(due, note) => run(async () => { await onReschedule(reminder.id, due, note); setEditing(false) })} />
    )
  }

  return (
    <div data-testid="reminder-row" data-state={state}
      style={{
        display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 8px 8px 12px',
        borderRadius: T.radius.inset,
        background: late ? T.state.warning.bg : T.surface.raised,
        border: late ? `1px solid ${T.state.warning.fg}` : T.border.card,
      }}>
      <span aria-hidden style={{ color: late ? T.state.warning.deep : T.accent.fg, display: 'inline-flex' }}><IconBell size={18} /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {showName ? (
          <>
            {onOpen
              ? <button type="button" onClick={() => onOpen(reminder)} style={{ border: 'none', background: 'transparent', padding: 0, font: 'inherit', fontSize: '15px', fontWeight: 600, color: T.ink.primary, cursor: 'pointer', textAlign: 'left', textDecoration: 'underline', textUnderlineOffset: '3px' }}>{reminder.record_name}</button>
              : <span style={{ fontSize: '15px', fontWeight: 600, color: T.ink.primary }}>{reminder.record_name}</span>}
            <p style={{ fontSize: '14px', color: T.ink.secondary, marginTop: '2px', overflowWrap: 'anywhere' }}>{reminder.note}</p>
          </>
        ) : (
          <p style={{ fontSize: '15px', color: T.ink.primary, overflowWrap: 'anywhere' }}>
            <strong style={{ fontWeight: 600 }}>Reminder:</strong> {reminder.note}
          </p>
        )}
        <p data-testid="reminder-when" style={{ fontSize: '13px', fontWeight: late ? 600 : 500, color: late ? T.state.warning.deep : T.ink.muted, marginTop: '2px' }}>
          {late ? `${when} · overdue` : when}
        </p>
        {failed && <p role="alert" style={{ fontSize: '13px', color: T.state.danger.fg, marginTop: '2px' }}>That didn&rsquo;t save. Please try again.</p>}
      </div>
      <button type="button" aria-label="Finish reminder" title="Done" disabled={busy} onClick={() => run(() => onFinish(reminder.id))} style={{ ...iconBtn, color: T.state.success.fg }}><IconCheck size={20} /></button>
      <button type="button" aria-label="Change date" title="Change date" disabled={busy} onClick={() => setEditing(true)} style={iconBtn}><IconPencil size={18} /></button>
      <button type="button" aria-label="Delete reminder" title="Delete" disabled={busy} onClick={() => run(() => onDelete(reminder.id))} style={iconBtn}><IconX size={18} /></button>
    </div>
  )
}

// ── on every record ──────────────────────────────────────────
// One hook per card, shared by the three places a reminder touches it:
//
//   RecordReminderList   — your reminders on this record, straight under the
//                          name ("Reminder: call about the garage, Tuesday").
//                          Renders NOTHING when there are none, so an empty
//                          record has no stray strip.
//   ReminderBarButton    — the bell in the card's bottom action bar (client
//                          and engagement), beside Call / Log touchpoint /
//                          Open in Jobber. Sits OUTSIDE ActionRow on purpose:
//                          ActionRow sizes its grid from the child count, so
//                          a fourth grid child would squeeze every button.
//   ReminderSetterPanel  — the three-tap setter, opened by the bar button OR
//                          the ··· menu item (reminderMenuItem). Same state,
//                          same save, whichever door you used.
//
// The Network person card has no bottom bar, so it passes inlineSetter to
// the list and the setter opens under the name instead.
//
// record: { key: 'lead_id' | 'engagement_id' | 'partner_id', id }
export function useRecordReminder(record, { now: nowProp = null } = {}) {
  const now = nowProp || new Date()
  const query = record?.id ? `${record.key}=${encodeURIComponent(record.id)}` : ''
  const api = useMyReminders(query, { enabled: !!record?.id })
  const [adding, setAdding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const save = async (due_on, note) => {
    setSaving(true); setFailed(false)
    try { await api.create({ [record.key]: record.id, due_on, note }); setAdding(false) }
    catch { setFailed(true) }
    finally { setSaving(false) }
  }
  return {
    record, now, today: todayYmd(now), ...api,
    list: api.reminders || [],
    adding, saving, failed, save,
    open: () => { setFailed(false); setAdding(true) },
    cancel: () => { setFailed(false); setAdding(false) },
  }
}

// The ··· menu entry. Both menus take { key, label }; CardMenu fires
// onPick, RecordMenu fires onClick — this item carries both.
export function reminderMenuItem(ctl) {
  return { key: 'reminder', label: 'Set a reminder', testid: 'menu-reminder', icon: <IconBell size={15} />, onPick: ctl.open, onClick: ctl.open }
}

export function ReminderSetterPanel({ ctl }) {
  if (!ctl.adding) return null
  return (
    <div data-testid="reminder-setter-panel" style={{ marginBottom: '8px' }}>
      <ReminderSetter now={ctl.now} saving={ctl.saving} onCancel={ctl.cancel} onDone={ctl.save} />
      {ctl.failed && <p role="alert" style={{ fontSize: '13px', color: T.state.danger.fg, marginTop: '4px' }}>That didn&rsquo;t save. Please try again.</p>}
    </div>
  )
}

export function RecordReminderList({ ctl, inlineSetter = false }) {
  if (!ctl.record?.id) return null
  if (ctl.list.length === 0 && !(inlineSetter && ctl.adding)) return null
  return (
    <div data-testid="record-reminder" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {ctl.list.map(r => (
        <ReminderRow key={r.id} reminder={r} today={ctl.today} now={ctl.now}
          onFinish={ctl.finish} onReschedule={ctl.reschedule} onDelete={ctl.remove} />
      ))}
      {inlineSetter && <ReminderSetterPanel ctl={ctl} />}
    </div>
  )
}

// The bar button. Colour: the brand GOLD pair (T.brand.goldSoft fill,
// T.brand.goldText ink, 5.6:1) — the bee's own colour, so it reads as its
// own thing, and nothing like the teal accent that Call / Send to Jobber
// wear. It is ActionRow's `trailing` action: fixed width at the end of the
// row on desktop, the last cell of a two-column grid on a phone (fill).
export function ReminderBarButton({ ctl, fill = false }) {
  const on = ctl.adding
  return (
    <button type="button" data-testid="reminder-button" aria-label="Set a reminder" title="Set a reminder"
      aria-expanded={on} onClick={on ? ctl.cancel : ctl.open}
      style={{
        flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
        height: '38px', width: fill ? '100%' : 'auto', minWidth: 0, padding: '0 14px',
        borderRadius: T.radius.inset, border: on ? `1.5px solid ${T.brand.goldText}` : 'none',
        background: T.brand.goldSoft, color: T.brand.goldText,
        fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', overflow: 'hidden',
      }}>
      <IconBell size={16} />
      <span style={{ fontSize: '13px' }}>Reminder</span>
    </button>
  )
}
