// components/hive/RemindersScreen.jsx
// ─────────────────────────────────────────────────────────────
// The two list views of Reminders:
//
//   RemindersScreen (default) — the Reminders page in the sidebar, two tabs:
//     · Mine — every open reminder of MINE, soonest due first, with the
//       person's name and the note. Tick to finish, pencil to change the
//       date, X to delete. Missed ones are amber. Personal.
//     · Bee Hub noticed — estimates that have waited (shared/noticed.js).
//       The LOCATION's, not a person's; nothing to tick; each leaves by
//       itself when the job moves. Never on Home.
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

import React, { useState, useMemo } from 'react'
import { IconBell } from '@/components/ui/icons'
import { T } from './shared/tokens'
import { ReminderRow, useMyReminders } from './shared/Reminders'
import { todayYmd, homeReminders } from '@/lib/reminders'
import { estimatesAwaitingReply } from './shared/noticed'
import { ESTIMATE_FOLLOWUP_DAYS } from './shared/attentionThresholds'

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

// ── the two tabs ─────────────────────────────────────────────
const TABS = [
  { key: 'mine', label: 'Mine' },
  { key: 'noticed', label: 'Bee Hub noticed' },
]

function TabButton({ tab, active, count, onPick }) {
  return (
    <button type="button" role="tab" aria-selected={active} data-testid={`reminders-tab-${tab.key}`} onClick={onPick}
      style={{
        padding: '10px 16px', minHeight: '44px', border: 'none', borderBottom: `2px solid ${active ? T.accent.fg : 'transparent'}`,
        background: 'transparent', color: active ? T.ink.primary : T.ink.muted, fontWeight: active ? 600 : 500,
        cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: '6px',
      }}>
      <span style={{ fontSize: '15px' }}>{tab.label}</span>
      {count != null && count > 0 && (
        <span style={{ fontSize: '12px', fontWeight: 600, padding: '0 7px', borderRadius: T.radius.pill, background: T.surface.sunken, color: T.ink.muted, fontVariantNumeric: T.type.tabular }}>{count}</span>
      )}
    </button>
  )
}

// One estimate that has waited. Opens the engagement; nothing to tick —
// it leaves this list by itself when the job moves.
function NoticedRow({ item, onOpen }) {
  return (
    <div data-testid="noticed-row" style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: T.radius.inset, background: T.surface.raised, border: T.border.card }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {onOpen
          ? <button type="button" onClick={() => onOpen({ record_type: 'engagement', engagement_id: item.engagement_id, client_id: item.client_id })}
              style={{ border: 'none', background: 'transparent', padding: 0, font: 'inherit', fontSize: '15px', fontWeight: 600, color: T.ink.primary, cursor: 'pointer', textAlign: 'left', textDecoration: 'underline', textUnderlineOffset: '3px' }}>{item.client_name}</button>
          : <span style={{ fontSize: '15px', fontWeight: 600, color: T.ink.primary }}>{item.client_name}</span>}
        <p style={{ fontSize: '14px', color: T.ink.secondary, marginTop: '2px', overflowWrap: 'anywhere' }}>
          Estimate sent, no answer yet{item.title ? ` · ${item.title}` : ''}
        </p>
      </div>
      <span data-testid="noticed-days" style={{ flexShrink: 0, fontSize: '13px', fontWeight: 600, color: T.ink.muted, fontVariantNumeric: T.type.tabular }}>
        {item.days} days
      </span>
    </div>
  )
}

// props:
//   onOpen(reminderLike)  — opens the record (client / engagement / Network)
//   engagements           — the Hub's open-engagement payload (for Noticed)
//   locationId            — the location Noticed is for; null on 'all'
//   locationName          — shown in Noticed's explanation
export default function RemindersScreen({ onOpen = null, now: nowProp = null, engagements = [], locationId = null, locationName = null, initialTab = 'mine' }) {
  const now = nowProp || new Date()
  const today = todayYmd(now)
  const [tab, setTab] = useState(initialTab === 'noticed' ? 'noticed' : 'mine')
  const { reminders, error, finish, reschedule, remove } = useMyReminders('')
  const noticed = useMemo(
    () => (locationId ? estimatesAwaitingReply(engagements, { locationId, nowMs: now.getTime() }) : []),
    [engagements, locationId, today], // eslint-disable-line react-hooks/exhaustive-deps
  )

  return (
    <div data-testid="reminders-screen" style={{ maxWidth: '760px', margin: '0 auto', padding: '20px 16px 80px', fontFamily: 'inherit' }}>
      <h1 style={{ fontSize: '24px', fontWeight: 600, color: T.ink.primary, letterSpacing: T.type.trackTitle }}>Reminders</h1>

      <div role="tablist" aria-label="Reminders" style={{ display: 'flex', gap: '4px', borderBottom: T.border.divider, margin: '12px 0 16px' }}>
        {TABS.map(t => (
          <TabButton key={t.key} tab={t} active={tab === t.key} onPick={() => setTab(t.key)}
            count={t.key === 'mine' ? (reminders ? reminders.length : null) : (locationId ? noticed.length : null)} />
        ))}
      </div>

      {tab === 'mine' && (
        <div role="tabpanel" data-testid="reminders-mine">
          <p style={{ fontSize: '14px', color: T.ink.muted, marginBottom: '16px', lineHeight: 1.5 }}>
            Reminders you set, soonest first. Only you see these. They show here and on Home on their day. Nothing is emailed.
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
      )}

      {tab === 'noticed' && (
        <div role="tabpanel" data-testid="reminders-noticed">
          {/* Said plainly because it is the opposite of Mine: nobody set
              these, everyone at the location sees the same list, and they
              leave by themselves. */}
          <div data-testid="noticed-explainer" style={{ background: T.surface.sunken, borderRadius: T.radius.inset, padding: '12px 14px', marginBottom: '16px' }}>
            <p style={{ fontSize: '14px', color: T.ink.secondary, lineHeight: 1.5 }}>
              <strong>Shared by everyone{locationName ? ` at ${locationName}` : ' at this location'}.</strong>{' '}
              Nobody set these — Bee Hub spotted them. Estimates sent more than {ESTIMATE_FOLLOWUP_DAYS} days ago that haven&rsquo;t been won, lost or moved on, longest waiting first.
            </p>
            <p style={{ fontSize: '14px', color: T.ink.secondary, lineHeight: 1.5, marginTop: '6px' }}>
              There&rsquo;s nothing to tick: each one goes away by itself when the job moves in Jobber.
            </p>
          </div>

          {!locationId && (
            <p data-testid="noticed-pick-location" style={{ fontSize: '14px', color: T.ink.muted }}>Choose a location to see what Bee Hub noticed there.</p>
          )}

          {locationId && noticed.length === 0 && (
            <p data-testid="noticed-empty" style={{ fontSize: '15px', color: T.ink.secondary }}>Nothing waiting. Every estimate has an answer or is still fresh.</p>
          )}

          {locationId && noticed.length > 0 && (
            <div style={{ display: 'grid', gap: '8px' }}>
              {noticed.map(item => <NoticedRow key={item.engagement_id} item={item} onOpen={onOpen} />)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
