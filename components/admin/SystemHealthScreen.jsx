// components/admin/SystemHealthScreen.jsx
// ─────────────────────────────────────────────────────────────
// Admin → System Health: verdict first, then the panels — connections,
// imports, webhooks, emails, "needs a look", the activity window, feedback.
// Read surface for app/api/admin/system-health (+ the existing admin
// feedback list for the Feedback panel).
//
// Built on tokens + shared primitives ONLY (the AdminNotificationsScreen
// posture): ui/tokens, hive/shared/tokens (T), FilterChips, StatusChip,
// BeeLoader — NO color literal of its own. The sweep in
// lib/beta-system-health-screen.test.tsx enforces that.
//
// HONESTY RULE. A health screen showing a fabricated figure is worse than
// one admitting a gap: every unknown renders as an explicit "not tracked
// yet" / "—", never a fake zero. The two known day-one gaps are the digest
// heartbeat (until migrations/digest_runs.sql is applied) and email counts
// (until migrations/notification_log.sql is applied).
'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { T, sage } from '@/components/hive/shared/tokens'
import { SECTION_LABEL, SECTION_COUNT, GREEN_FILL } from '@/components/ui/tokens'
import FilterChips from '@/components/ui/FilterChips'
import StatusChip from '@/components/ui/StatusChip'
import BeeLoader from '@/components/hive/shared/BeeLoader'

const WINDOWS = [
  { key: '24h', label: 'Last 24 hours' },
  { key: '7d', label: 'Last 7 days' },
]

const fmtAgo = (iso) => {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

const fmtMoney = (n) =>
  typeof n === 'number'
    ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    : '—'

const fmtResume = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })
}

// Tile tone → fg color. Status colors are reserved semantics (never series
// paint): ok=success, warn=warning, bad=danger, none=quiet.
const TONE_FG = {
  ok: () => T.state.success.fg,
  warn: () => T.state.warning.fg,
  bad: () => T.state.danger.fg,
  none: () => T.ink.quiet,
}

function Tile({ label, tone = 'none', state, sub }) {
  const fg = (TONE_FG[tone] || TONE_FG.none)()
  return (
    <div style={{
      background: T.surface.raised, border: T.border.card, borderRadius: T.radius.inset,
      boxShadow: T.shadow.card, padding: '11px 13px', minWidth: 0,
    }}>
      <div style={{ ...SECTION_LABEL, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', margin: '6px 0 2px' }}>
        <span aria-hidden="true" style={{ width: '9px', height: '9px', borderRadius: T.radius.round, background: fg, flexShrink: 0 }} />
        <span style={{ fontSize: '15px', fontWeight: 600, color: fg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{state}</span>
      </div>
      <div style={{ fontSize: '12px', color: T.ink.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={sub || ''}>{sub || ' '}</div>
    </div>
  )
}

function Card({ children }) {
  return (
    <div style={{
      background: T.surface.raised, border: T.border.card, borderRadius: T.radius.inset,
      boxShadow: T.shadow.card, padding: '13px 15px',
    }}>
      {children}
    </div>
  )
}

function SectionLabel({ children, count, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <span style={{ ...SECTION_LABEL, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{children}</span>
      {count != null && <span style={SECTION_COUNT}>· {count}</span>}
      {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
    </div>
  )
}

function Stat({ value, label }) {
  return (
    <div style={{ background: T.surface.sunken, borderRadius: T.radius.control, padding: '9px 6px 8px', textAlign: 'center', minWidth: 0 }}>
      <div style={{ fontSize: '21px', fontWeight: 650, color: T.ink.primary, lineHeight: 1.15, fontVariantNumeric: 'tabular-nums' }}>
        {value == null ? '—' : value}
      </div>
      <div style={{ fontSize: '11px', color: T.ink.muted }}>{label}</div>
    </div>
  )
}

const linkStyle = {
  border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
  fontFamily: 'inherit', fontSize: '12px', fontWeight: 500, color: GREEN_FILL,
  textDecoration: 'underline', textUnderlineOffset: '2px',
}

export default function SystemHealthScreen({ onNavigate = null, role = null }) {
  const [data, setData] = useState(null)
  const [feedback, setFeedback] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [window_, setWindow] = useState('24h')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/system-health?window=${window_}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch (err) {
      setError(err?.message || String(err))
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [window_])

  useEffect(() => { load() }, [load])

  // The Feedback panel reads the existing triage list — user reports are
  // already captured in feedback_items; this panel only surfaces them.
  useEffect(() => {
    let cancelled = false
    fetch('/api/admin/feedback?status=submitted')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d && Array.isArray(d.items)) setFeedback(d.items) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  if (loading && !data) {
    return <BeeLoader label="Checking system health…" />
  }
  if (error) {
    return (
      <Card>
        <p style={{ fontSize: '13px', fontWeight: 500, color: T.ink.primary, marginBottom: '4px' }}>Couldn’t load system health</p>
        <p style={{ fontSize: '12px', color: T.ink.muted }}>{error}</p>
      </Card>
    )
  }
  if (!data) return null

  const v = data.verdict || { level: 'amber', problems: [], cautions: [], attention: 0 }
  const bannerFamily = v.level === 'red' ? T.family.red : v.level === 'amber' ? T.family.amber : T.family.green
  const bannerDot = v.level === 'red' ? T.state.danger.strong : v.level === 'amber' ? T.state.warning.fg : T.state.success.fg
  const bannerCopy =
    v.level === 'red'
      ? v.problems.join(' · ')
      : v.level === 'amber'
        ? [
            v.attention > 0 ? `${v.attention} thing${v.attention === 1 ? '' : 's'} need${v.attention === 1 ? 's' : ''} a look` : null,
            ...(v.cautions || []),
          ].filter(Boolean).join(' · ') || 'Nothing broken.'
        : 'All clear. Connections healthy, imports quiet, no webhook failures in the last 24 hours.'

  const digestLine = (() => {
    const d = data.digest
    if (!d || !d.tracked) {
      return { text: 'Slack digest: run tracking isn’t wired yet — apply migrations/digest_runs.sql to see liveness here.', warn: false }
    }
    if (!d.lastRunAt) return { text: 'Slack digest: no runs recorded yet.', warn: false }
    const outcome = d.suppressed ? 'quiet window, nothing to post' : d.posted ? 'posted' : 'ran, not posted'
    return { text: `Slack digest ran ${fmtAgo(d.lastRunAt)} — ${outcome}.`, warn: !!d.stale }
  })()

  // ── tiles ──
  const jobberTile = (() => {
    const j = data.jobber
    if (!j) return { tone: 'none', state: '—', sub: 'couldn’t read' }
    if (j.problems.length > 0) {
      return {
        tone: 'bad',
        state: `${j.problems.length} need${j.problems.length === 1 ? 's' : ''} attention`,
        sub: j.problems.map(p => p.name).join(', '),
      }
    }
    return {
      tone: 'ok', state: 'Healthy',
      sub: `${j.connected} of ${j.total} connected${j.autoRefreshing ? ` · ${j.autoRefreshing} auto-refreshing` : ''}`,
    }
  })()

  const webhookTile = (() => {
    const w = data.webhooks
    if (!w) return { tone: 'none', state: '—', sub: 'couldn’t read' }
    const missed = (w.failed || 0) + (w.notLanded || 0)
    if (missed > 0) return { tone: 'bad', state: `${missed} didn’t land`, sub: `${w.total ?? '—'} in over 24h` }
    return { tone: 'ok', state: 'Clear', sub: `${w.total ?? '—'} in · 0 failed` }
  })()

  const importTile = (() => {
    const im = data.imports
    if (!im) return { tone: 'none', state: '—', sub: 'couldn’t read' }
    if (im.stalled > 0) return { tone: 'bad', state: `${im.stalled} stalled`, sub: 'claim not refreshing' }
    if (im.failed24h > 0) return { tone: 'bad', state: `${im.failed24h} failed`, sub: 'in the last 24 hours' }
    const parked = (im.running || []).filter(r => r.parked)
    const active = (im.running || []).filter(r => !r.parked)
    if (active.length > 0) {
      const a = active[0]
      return { tone: 'ok', state: 'Running', sub: `${a.name}${a.processed != null && a.total != null ? ` · ${a.processed.toLocaleString()} / ${a.total.toLocaleString()}` : ''}` }
    }
    if (parked.length > 0) {
      const p = parked[0]
      return { tone: 'warn', state: `${parked.length} parked`, sub: `${p.name}${p.resumeAfter ? ` · resumes ${fmtResume(p.resumeAfter)}` : ''}` }
    }
    return { tone: 'ok', state: 'Quiet', sub: im.failed7d > 0 ? `${im.failed7d} failed this week` : 'no failures this week' }
  })()

  const emailTile = (() => {
    const e = data.emails
    if (!e) return { tone: 'none', state: '—', sub: 'couldn’t read' }
    if (!e.tracked) return { tone: 'none', state: 'Not tracked yet', sub: 'run migrations/notification_log.sql' }
    if ((e.failed || 0) > 0) return { tone: 'warn', state: `${e.failed} failed`, sub: `${e.total ?? 0} sent over 24h` }
    return { tone: 'ok', state: 'Sending', sub: `${e.total ?? 0} accepted · 0 failed` }
  })()

  const a = data.activity
  const maxDay = Math.max(1, ...(a?.perDay || []).map(d => d.count))
  const topLine = (rows) =>
    (rows || []).slice(0, 3).map((r, i) => (i === 0 ? `${r.label} ${r.count}` : ` · ${r.label} ${r.count}`)).join('') || '—'

  const fb = data.feedback
  const fbItems = feedback || fb?.newest || []

  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 500, color: T.ink.primary, margin: 0 }}>System Health</h2>
        <span style={SECTION_COUNT}>checked {fmtAgo(data.generatedAt)}</span>
        <button
          onClick={load}
          style={{
            marginLeft: 'auto', padding: '4px 10px', border: T.border.control,
            borderRadius: T.radius.control, background: T.surface.raised,
            color: T.ink.secondary, fontFamily: 'inherit', fontSize: '12px', cursor: 'pointer',
          }}
        >
          Refresh
        </button>
      </div>

      {/* ── verdict banner ── */}
      <div style={{
        borderRadius: T.radius.control, padding: '11px 14px',
        display: 'flex', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap',
        background: bannerFamily.bg, color: bannerFamily.text,
      }}>
        <span aria-hidden="true" style={{ width: '10px', height: '10px', borderRadius: T.radius.round, background: bannerDot, flexShrink: 0, alignSelf: 'center' }} />
        <span style={{ fontSize: '14px', fontWeight: 500, flex: '1 1 auto', minWidth: '200px' }}>{bannerCopy}</span>
        <span style={{ fontSize: '12px', color: digestLine.warn ? T.state.warning.fg : bannerFamily.text, opacity: digestLine.warn ? 1 : 0.85 }}>
          {digestLine.warn && data.digest?.lastRunAt
            ? `Slack digest hasn’t run in ${fmtAgo(data.digest.lastRunAt).replace(' ago', '')} — likely a stale-deployment cron.`
            : digestLine.text}
        </span>
      </div>

      {/* ── status tiles ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px' }}>
        <Tile label="Jobber" tone={jobberTile.tone} state={jobberTile.state} sub={jobberTile.sub} />
        <Tile label="Webhooks · 24h" tone={webhookTile.tone} state={webhookTile.state} sub={webhookTile.sub} />
        <Tile label="Imports" tone={importTile.tone} state={importTile.state} sub={importTile.sub} />
        <Tile label="Emails · 24h" tone={emailTile.tone} state={emailTile.state} sub={emailTile.sub} />
      </div>
      {data.jobber && data.jobber.problems.length > 0 && role === 'super_admin' && onNavigate && (
        <div style={{ marginTop: '-6px' }}>
          <button style={linkStyle} onClick={() => onNavigate('jobber')}>Open Jobber Health →</button>
        </div>
      )}

      {/* ── needs a look ── */}
      <Card>
        <SectionLabel count={data.needsALook?.length || 0}>Needs a look</SectionLabel>
        {(data.needsALook || []).length === 0 ? (
          <p style={{ fontSize: '13px', color: T.ink.quiet, margin: '10px 0 2px' }}>Nothing needs a look.</p>
        ) : (
          <div style={{ display: 'grid', gap: '6px', marginTop: '10px' }}>
            {data.needsALook.map((item, i) => (
              <div key={`${item.key}-${i}`} style={{
                display: 'flex', alignItems: 'center', gap: '10px',
                background: T.family.amber.bg, color: T.family.amber.text,
                borderRadius: T.radius.control, padding: '8px 12px',
                fontSize: '13px', fontWeight: 500,
              }}>
                {item.label}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ── activity window ── */}
      <Card>
        <SectionLabel right={<FilterChips items={WINDOWS} active={window_} onChange={setWindow} />}>
          Activity
        </SectionLabel>
        {a ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))', gap: '8px', marginTop: '12px' }}>
              <Stat value={a.leadsIn} label="leads in" />
              <Stat value={a.requests} label="requests" />
              <Stat value={a.quotesSent} label="quotes sent" />
              <Stat value={a.jobsBooked} label="jobs booked" />
              <Stat value={a.invoicesPaid} label="invoices paid" />
              <Stat value={a.wonCount != null ? `${fmtMoney(a.wonValue)}` : null} label={`won${a.wonCount ? ` · ${a.wonCount} deal${a.wonCount === 1 ? '' : 's'}` : ''}`} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginTop: '10px', paddingTop: '9px', borderTop: T.border.divider, fontSize: '13px', color: T.ink.muted }}>
              <span>Sources: <span style={{ color: T.ink.primary, fontWeight: 500 }}>{topLine(a.bySource)}</span></span>
              <span>Busiest: <span style={{ color: T.ink.primary, fontWeight: 500 }}>{topLine(a.byLocation)}</span></span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '10px', fontSize: '12px', color: T.ink.quiet }}>
              <span>Leads per day, last 7 days</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{a.perDay?.length ? a.perDay[a.perDay.length - 1].count : '—'} today</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '4px', height: '36px', marginTop: '4px' }} role="img" aria-label="Leads per day, last 7 days">
              {(a.perDay || []).map((d, i) => (
                <div
                  key={d.day}
                  title={`${d.day}: ${d.count}`}
                  style={{
                    flex: 1,
                    height: `${Math.max(8, Math.round((d.count / maxDay) * 100))}%`,
                    background: i === (a.perDay.length - 1) ? GREEN_FILL : sage(0.9),
                    borderRadius: '3px 3px 0 0',
                    minHeight: '3px',
                  }}
                />
              ))}
            </div>
          </>
        ) : (
          <p style={{ fontSize: '13px', color: T.ink.quiet, margin: '10px 0 2px' }}>Couldn’t read activity.</p>
        )}
      </Card>

      {/* ── feedback — surfacing the existing feedback_items triage ── */}
      <Card>
        <SectionLabel
          count={fb?.open ?? (feedback ? feedback.length : null)}
          right={onNavigate ? <button style={linkStyle} onClick={() => onNavigate('feedback')}>Open triage →</button> : null}
        >
          Feedback
        </SectionLabel>
        {fbItems.length === 0 ? (
          <p style={{ fontSize: '13px', color: T.ink.quiet, margin: '10px 0 2px' }}>No open reports.</p>
        ) : (
          <div style={{ display: 'grid', gap: '2px', marginTop: '8px' }}>
            {fbItems.slice(0, 3).map((item) => (
              <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 0', borderTop: T.border.divider, fontSize: '13px', color: T.ink.primary }}>
                <StatusChip label={item.type === 'bug' ? 'bug' : 'feature'} styleKey={item.type === 'bug' ? 'red' : 'blue'} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
                <span style={{ ...SECTION_COUNT, whiteSpace: 'nowrap' }}>
                  {(item.locationName || item.location_name) ? `${item.locationName || item.location_name} · ` : ''}{fmtAgo(item.createdAt || item.created_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
