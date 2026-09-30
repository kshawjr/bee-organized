// components/hive/RemindersScreen.jsx
// ─────────────────────────────────────────────────────────────
// The two list views of Reminders:
//
//   RemindersScreen (default) — the Reminders page in the sidebar. Every
//     open reminder of MINE, soonest due first, with the person's name and
//     the note. Tick to finish, pencil to change the date, X to delete.
//     Missed ones are amber.
//   HomeReminders — the block at the top of Home. Overdue (amber) first,
//     then today's. Nothing later than today; nothing at all when there is
//     nothing due, so a calm Home stays calm.
//
// Props only (§8.5): the host passes onOpen(reminder) to open the record the
// reminder is about. Rows and data come from shared/Reminders so the record
// strip, Home and this page cannot disagree.
//
// Nothing here sends anything. No email, no Slack, no alert.
// ─────────────────────────────────────────────────────────────
'use client'

import React from 'react'
import { IconBell } from '@/components/ui/icons'
import { T } from './shared/tokens'
import { ReminderRow, useMyReminders } from './shared/Reminders'
import { todayYmd, homeReminders } from '@/lib/reminders'

export function HomeReminders({ onOpen = null, onSeeAll = null, now: nowProp = null }) {
  const now = nowProp || new Date()
  const today = todayYmd(now)
  const { reminders, finish, reschedule, remove } = useMyReminders('')
  if (!reminders) return null
  const { overdue, today: dueToday } = homeReminders(reminders, today)
  if (overdue.length + dueToday.length === 0) return null

  const row = (r) => (
    <ReminderRow key={r.id} reminder={r} today={today} now={now} showName onOpen={onOpen}
      onFinish={finish} onReschedule={reschedule} onDelete={remove} />
  )

  return (
    <div data-testid="home-reminders">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '8px' }}>
        <p style={{ fontSize: '11px', fontWeight: 700, color: T.ink.muted, textTransform: 'uppercase', letterSpacing: '0.6px' }}>Reminders</p>
        {onSeeAll && (
          <button type="button" onClick={onSeeAll}
            style={{ marginLeft: 'auto', border: 'none', background: 'transparent', padding: 0, fontFamily: 'inherit', fontSize: '13px', fontWeight: 500, color: T.accent.fg, cursor: 'pointer' }}>
            All reminders ›
          </button>
        )}
      </div>
      <div style={{ display: 'grid', gap: '8px' }}>
        {overdue.length > 0 && (
          <div data-testid="home-reminders-overdue" style={{ display: 'grid', gap: '8px' }}>{overdue.map(row)}</div>
        )}
        {dueToday.length > 0 && (
          <div data-testid="home-reminders-today" style={{ display: 'grid', gap: '8px' }}>{dueToday.map(row)}</div>
        )}
      </div>
    </div>
  )
}

export default function RemindersScreen({ onOpen = null, now: nowProp = null }) {
  const now = nowProp || new Date()
  const today = todayYmd(now)
  const { reminders, error, finish, reschedule, remove } = useMyReminders('')

  return (
    <div data-testid="reminders-screen" style={{ maxWidth: '760px', margin: '0 auto', padding: '20px 16px 80px', fontFamily: 'inherit' }}>
      <h1 style={{ fontSize: '24px', fontWeight: 600, color: T.ink.primary, letterSpacing: T.type.trackTitle }}>Reminders</h1>
      <p style={{ fontSize: '14px', color: T.ink.muted, marginTop: '4px', marginBottom: '16px', lineHeight: 1.5 }}>
        Yours, soonest first. They show here and on Home on their day. Nothing is emailed.
      </p>

      {reminders == null && <p style={{ fontSize: '14px', color: T.ink.quiet }}>Loading…</p>}

      {reminders != null && error && reminders.length === 0 && (
        <p role="alert" style={{ fontSize: '14px', color: T.state.danger.fg }}>Your reminders didn&rsquo;t load. Please refresh the page.</p>
      )}

      {reminders != null && !error && reminders.length === 0 && (
        <div data-testid="reminders-empty" style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', background: T.surface.raised, border: T.border.card, borderRadius: T.radius.card, padding: '16px' }}>
          <span aria-hidden style={{ color: T.accent.fg }}><IconBell size={20} /></span>
          <p style={{ fontSize: '15px', color: T.ink.secondary, lineHeight: 1.5 }}>
            No reminders yet. Open any client, lead, job or Network person and press <strong>Reminder</strong>.
          </p>
        </div>
      )}

      {reminders != null && reminders.length > 0 && (
        <div style={{ display: 'grid', gap: '8px' }}>
          {reminders.map(r => (
            <ReminderRow key={r.id} reminder={r} today={today} now={now} showName onOpen={onOpen}
              onFinish={finish} onReschedule={reschedule} onDelete={remove} />
          ))}
        </div>
      )}
    </div>
  )
}
