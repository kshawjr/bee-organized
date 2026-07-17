// components/admin/AdminNotificationsScreen.jsx
// ─────────────────────────────────────────────────────────────
// The outbound-mail notebook, read (migrations/notification_log.sql).
// Every email Bee Hub sends through Resend — invites, magic-links, drips, lead
// notifications — plus the Slack lead posts. One row per RECIPIENT per send.
//
// DESIGN CALL (Kevin, this build). The existing Webhooks tab
// (AdminWebhookLogScreen, a ~300-line BeeHub.jsx internal) predates the design
// system and carries its own inline hex; it is NOT the model here. This screen
// is built on the tokens + shared primitives — ui/tokens, hive/shared/tokens
// (T), FilterChips, StatusChip, Card — and carries NO color literal of its own.
// The sweep in lib/beta-notification-log-screen.test.tsx enforces that, so this
// file cannot drift back toward the precedent it deliberately departs from.
//
// WHAT 'accepted' MEANS. Half A logs ACCEPTANCE, not delivery: Resend took the
// message and returned an id. It does NOT mean the mail reached an inbox. The
// Delivery column stays blank until Half B (the Resend delivery webhook) fills
// delivery_status by resend_message_id — the UI says "—" rather than implying
// success, because conflating the two is exactly the error this screen exists
// to prevent an operator from making.
'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { T } from '@/components/hive/shared/tokens'
import { SECTION_LABEL, SECTION_COUNT } from '@/components/ui/tokens'
import FilterChips from '@/components/ui/FilterChips'
import StatusChip from '@/components/ui/StatusChip'

// send_status → chip family. Deliberate: 'accepted' is teal (in motion / go),
// NOT the won-green — green would read as "delivered", which Half A cannot
// know. zero_recipients is amber: nothing failed, but a location with nobody
// subscribed is a loose end worth chasing.
//
// 'muted' is GRAY, and that is the point: gray is the one family that reads as
// "working as intended, nothing to do". A muted row means the location's
// notifications_live flag is off during the Zoho-parallel migration — expected
// for 45 of 51 locations, and the opposite of the amber loose-end that
// zero_recipients marks. Amber here would put a permanent chase-me badge on
// every lead at every not-yet-cut-over location.
const STATUS_STYLE = {
  accepted: 'teal',
  failed: 'red',
  zero_recipients: 'amber',
  muted: 'gray',
}
const STATUS_LABEL = {
  accepted: 'Accepted',
  failed: 'Failed',
  zero_recipients: 'No recipients',
  muted: 'Muted',
}

// delivery_status → chip family (Half B fills these; every row reads '—' today).
const DELIVERY_STYLE = {
  delivered: 'green',
  bounced: 'red',
  complained: 'red',
  deferred: 'amber',
  opened: 'blue',
  clicked: 'blue',
}

const WINDOWS = [
  { key: '24h', label: '24 hours' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'all', label: 'All time' },
]

const fmtWhen = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

const controlStyle = {
  padding: '5px 8px',
  border: T.border.control,
  borderRadius: T.radius.control,
  background: T.surface.raised,
  color: T.ink.primary,
  fontSize: '12px',
  fontFamily: 'inherit',
  outline: 'none',
}

export default function AdminNotificationsScreen({ locations = [] }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [truncated, setTruncated] = useState(false)
  const [needsMigration, setNeedsMigration] = useState(false)

  const [window_, setWindow] = useState('7d')
  const [status, setStatus] = useState('all')
  const [locationId, setLocationId] = useState('')
  const [emailKind, setEmailKind] = useState('')
  const [search, setSearch] = useState('')
  // Committed search term — the fetch key. Typing alone must not fire a
  // request per keystroke against a table that grows with every send.
  const [query, setQuery] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const p = new URLSearchParams({ window: window_ })
      if (status !== 'all') p.set('status', status)
      if (locationId) p.set('location_id', locationId)
      if (emailKind) p.set('email_kind', emailKind)
      if (query) p.set('q', query)
      const res = await fetch(`/api/admin/notification-log?${p.toString()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = await res.json()
      setRows(Array.isArray(d.events) ? d.events : [])
      setTruncated(!!d.truncated)
      setNeedsMigration(!!d.needs_migration)
    } catch (err) {
      setError(err?.message || String(err))
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [window_, status, locationId, emailKind, query])

  useEffect(() => { load() }, [load])

  // Counts describe the CURRENT payload. When a status filter is active the
  // server already narrowed the read, so the other segments' counts would be
  // structurally zero and read as "there are none" rather than "not counted" —
  // so they're shown only on the unfiltered view.
  const counts = useMemo(() => {
    if (status !== 'all') return null
    const c = { all: rows.length, accepted: 0, failed: 0, zero_recipients: 0, muted: 0 }
    for (const r of rows) if (c[r.send_status] !== undefined) c[r.send_status] += 1
    return c
  }, [rows, status])

  // email_kind is free text by design (no CHECK), so the filter's options come
  // from what's actually in the window, not a hardcoded list a new send rail
  // would fall off of.
  const kinds = useMemo(
    () => Array.from(new Set(rows.map(r => r.email_kind).filter(Boolean))).sort(),
    [rows],
  )

  const chipItems = [
    { key: 'all', label: 'All', count: counts?.all },
    { key: 'accepted', label: 'Accepted', count: counts?.accepted },
    { key: 'failed', label: 'Failed', count: counts?.failed },
    { key: 'zero_recipients', label: 'No recipients', count: counts?.zero_recipients, muted: true },
    // Two senses of "muted" collide on this line and they are unrelated: key
    // 'muted' is the send_status being filtered for; `muted: true` is
    // FilterChips' de-emphasis prop, the same one 'No recipients' carries.
    { key: 'muted', label: 'Muted', count: counts?.muted, muted: true },
  ]

  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <div>
        <h2 style={{ fontSize: '16px', fontWeight: 500, color: T.ink.primary, marginBottom: '2px' }}>
          Notifications
        </h2>
        <p style={{ ...SECTION_LABEL, color: T.ink.muted }}>
          Every email sent through Resend, one row per recipient. “Accepted” means Resend took
          the message — not that it landed. Delivery arrives with the Resend webhook.
        </p>
      </div>

      {/* ── Filters ─────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
        <select value={window_} onChange={e => setWindow(e.target.value)} style={controlStyle} aria-label="Time window">
          {WINDOWS.map(w => <option key={w.key} value={w.key}>{w.label}</option>)}
        </select>
        <select value={locationId} onChange={e => setLocationId(e.target.value)} style={controlStyle} aria-label="Location">
          <option value="">All locations</option>
          {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select value={emailKind} onChange={e => setEmailKind(e.target.value)} style={controlStyle} aria-label="Email kind">
          <option value="">All kinds</option>
          {kinds.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search recipient, subject, or lead…"
          aria-label="Search notifications"
          style={{ ...controlStyle, flex: '1 1 220px', minWidth: '160px' }}
        />
      </div>

      <FilterChips items={chipItems} active={status} onChange={setStatus} />

      {/* ── Body ────────────────────────────────────────────── */}
      {needsMigration ? (
        <Notice
          title="The notification_log table doesn’t exist yet"
          body="The logging code is live and failing safe — sends are working, they just aren’t being recorded. Run migrations/notification_log.sql in the Supabase SQL editor and rows will start landing."
        />
      ) : error ? (
        <Notice title="Couldn’t load the notification log" body={error} />
      ) : loading ? (
        <p style={{ ...SECTION_LABEL, color: T.ink.quiet, padding: '16px 0' }}>Loading…</p>
      ) : rows.length === 0 ? (
        <Notice
          title="Nothing in this window"
          body="No notifications match these filters. Widen the time window, or clear the filters."
        />
      ) : (
        <>
          {truncated && (
            <p style={{ ...SECTION_COUNT, color: T.ink.muted }}>
              Showing the most recent 500 — there are more in this window. Narrow the filters to see them.
            </p>
          )}
          <LogTable rows={rows} />
        </>
      )}
    </div>
  )
}

function Notice({ title, body }) {
  return (
    <div style={{
      border: T.border.card,
      borderRadius: T.radius.card,
      background: T.surface.sunken,
      padding: '16px',
    }}>
      <p style={{ fontSize: '13px', fontWeight: 500, color: T.ink.primary, marginBottom: '4px' }}>{title}</p>
      <p style={{ fontSize: '12px', color: T.ink.muted, lineHeight: 1.5 }}>{body}</p>
    </div>
  )
}

const TH = {
  ...SECTION_LABEL,
  textAlign: 'left',
  padding: '0 10px 8px',
  whiteSpace: 'nowrap',
}
const TD = {
  fontSize: '12px',
  color: T.ink.primary,
  padding: '9px 10px',
  borderTop: T.border.divider,
  verticalAlign: 'top',
}

function LogTable({ rows }) {
  return (
    // Wide content scrolls inside its own container — the page body never
    // scrolls sideways (the §7 mobile rule the filter strip follows too).
    <div style={{
      border: T.border.card,
      borderRadius: T.radius.card,
      background: T.surface.raised,
      boxShadow: T.shadow.card,
      overflowX: 'auto',
      padding: '10px 2px 2px',
    }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '760px' }}>
        <thead>
          <tr>
            <th style={TH}>When</th>
            <th style={TH}>Status</th>
            <th style={TH}>Kind</th>
            <th style={TH}>Recipient</th>
            <th style={TH}>Subject</th>
            <th style={TH}>Lead</th>
            <th style={TH}>Location</th>
            <th style={TH}>Delivery</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td style={{ ...TD, color: T.ink.muted, whiteSpace: 'nowrap' }}>{fmtWhen(r.created_at)}</td>
              <td style={TD}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', alignItems: 'flex-start' }}>
                  <StatusChip
                    label={STATUS_LABEL[r.send_status] || r.send_status}
                    styleKey={STATUS_STYLE[r.send_status] || 'gray'}
                  />
                  {r.channel === 'slack' && <span style={{ ...SECTION_COUNT }}>Slack</span>}
                  {/* The error is the whole reason a failed row is worth
                      reading — shown inline, not hidden behind a click. */}
                  {r.error && (
                    <span style={{ fontSize: '11px', color: T.ink.muted, whiteSpace: 'normal', maxWidth: '220px' }}>
                      {r.error}
                    </span>
                  )}
                </div>
              </td>
              <td style={{ ...TD, color: T.ink.secondary, whiteSpace: 'nowrap' }}>{r.email_kind || '—'}</td>
              <td style={{ ...TD, color: T.ink.secondary }}>{r.recipient || '—'}</td>
              <td style={{ ...TD, maxWidth: '260px' }}>{r.subject || '—'}</td>
              <td style={{ ...TD, color: T.ink.secondary }}>{r.lead_name || '—'}</td>
              <td style={{ ...TD, color: T.ink.muted, whiteSpace: 'nowrap' }}>{r.location_slug || '—'}</td>
              <td style={TD}>
                {r.delivery_status ? (
                  <StatusChip
                    label={r.delivery_status}
                    styleKey={DELIVERY_STYLE[r.delivery_status] || 'gray'}
                  />
                ) : (
                  // Half A knows nothing about delivery. A blank is honest;
                  // anything else would imply a fact we don't have.
                  <span style={{ ...SECTION_COUNT, color: T.ink.quiet }}>—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
