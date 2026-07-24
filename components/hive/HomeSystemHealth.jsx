// components/hive/HomeSystemHealth.jsx
// ─────────────────────────────────────────────────────────────
// Home, for an ELEVATED user viewing ALL LOCATIONS: a Home-sized system-
// health summary that stands in for the operational Home. The principle —
// Home shows the state of whatever you're looking at: the whole system when
// viewing everything, one territory's work when scoped in. Scoped-in and
// every non-elevated user keep the operational Home; the gate lives in
// DashboardScreen (isElevated && locFilter==='all') and is CLIENT-SIDE so
// view-as can't leak this panel into an impersonated owner's Home.
//
// ONE SOURCE, TWO PRESENTATIONS. This reads the SAME /api/admin/system-health
// endpoint that Admin → System Health (components/admin/SystemHealthScreen)
// reads, and renders the SAME server-computed verdict (data.verdict.level).
// Two health verdicts that could disagree is the failure mode this avoids by
// never recomputing one — the verdict is decided once, server-side. This is
// the compact cut: verdict + four tiles + a short look-list + a 24h activity
// line + open feedback, then a link to the deep view. No window toggle (the
// compact view is always "last 24 hours"), no per-panel deep-dives.
//
// DASHBOARD LAYOUT (presentation only): a one-line verdict banner, four status
// tiles across, then "Needs a look" and "Last 24 hours" side by side at half
// width each, and a full-width Feedback panel split internally into two
// columns. Collapses to a single column below the app's mobile breakpoint
// (useIsMobile → 768px). No data, fetch, or verdict logic changes here.
//
// TOKENS ONLY, like SystemHealthScreen: ui/tokens + hive/shared/tokens, NO
// color literal of its own (the sweep in lib/beta-home-system-health.test.tsx
// enforces it). HONESTY RULE holds: unknowns render as explicit gaps, never
// fake zeros.
'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { T } from '@/components/hive/shared/tokens'
import { SECTION_LABEL, SECTION_COUNT, GREEN_FILL } from '@/components/ui/tokens'
import StatusChip from '@/components/ui/StatusChip'
import BeeLoader from '@/components/hive/shared/BeeLoader'
import useIsMobile from '@/components/hive/shared/useIsMobile'

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

// Tile tone → fg. Status colors are reserved semantics (never series paint),
// same mapping SystemHealthScreen uses so the two surfaces read identically.
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
      boxShadow: T.shadow.card, padding: '9px 11px', minWidth: 0,
    }}>
      <div style={{ ...SECTION_LABEL, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', margin: '5px 0 1px' }}>
        <span aria-hidden="true" style={{ width: '8px', height: '8px', borderRadius: T.radius.round, background: fg, flexShrink: 0 }} />
        <span style={{ fontSize: '14px', fontWeight: 600, color: fg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{state}</span>
      </div>
      <div style={{ fontSize: '11px', color: T.ink.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={sub || ''}>{sub || ' '}</div>
    </div>
  )
}

function Card({ children }) {
  return (
    <div style={{
      background: T.surface.raised, border: T.border.card, borderRadius: T.radius.inset,
      boxShadow: T.shadow.card, padding: '11px 13px',
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
    <div style={{ background: T.surface.sunken, borderRadius: T.radius.control, padding: '7px 5px 6px', textAlign: 'center', minWidth: 0 }}>
      <div style={{ fontSize: '18px', fontWeight: 650, color: T.ink.primary, lineHeight: 1.15, fontVariantNumeric: 'tabular-nums' }}>
        {value == null ? '—' : value}
      </div>
      <div style={{ fontSize: '11px', color: T.ink.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
    </div>
  )
}

const linkStyle = {
  border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
  fontFamily: 'inherit', fontSize: '13px', fontWeight: 500, color: GREEN_FILL,
  textDecoration: 'underline', textUnderlineOffset: '2px',
}

export default function HomeSystemHealth({ onOpenFull = null }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Two-column dashboard layout collapses to one column below the app's
  // standard mobile breakpoint (useIsMobile → 768px). Presentation only.
  const isMobile = useIsMobile()

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // The compact Home cut is always the 24h window. Same endpoint the deep
      // view fetches — one source of truth for the verdict.
      const res = await fetch('/api/admin/system-health?window=24h')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch (err) {
      setError(err?.message || String(err))
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

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
        : 'All clear across every location.'

  // The digest heartbeat rides in the banner subline — the stale-cron detector.
  const digestLine = (() => {
    const d = data.digest
    if (!d || !d.tracked) return { text: 'Digest liveness isn’t wired yet', warn: false }
    if (!d.lastRunAt) return { text: 'Digest: no runs recorded yet', warn: false }
    if (d.stale) return { text: `Digest hasn’t run in ${fmtAgo(d.lastRunAt).replace(' ago', '')} — likely a stale cron`, warn: true }
    return { text: `Digest ran ${fmtAgo(d.lastRunAt)}`, warn: false }
  })()

  // ── tiles — same tone/copy rules as SystemHealthScreen ──
  const jobberTile = (() => {
    const j = data.jobber
    if (!j) return { tone: 'none', state: '—', sub: 'couldn’t read' }
    if (j.problems.length > 0) {
      return { tone: 'bad', state: `${j.problems.length} need${j.problems.length === 1 ? 's' : ''} attention`, sub: j.problems.map(p => p.name).join(', ') }
    }
    return { tone: 'ok', state: 'Healthy', sub: `${j.connected} of ${j.total} connected` }
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
    const active = (im.running || []).filter(r => !r.parked)
    if (active.length > 0) return { tone: 'ok', state: 'Running', sub: active[0].name }
    const parked = (im.running || []).filter(r => r.parked)
    if (parked.length > 0) return { tone: 'warn', state: `${parked.length} parked`, sub: parked[0].name }
    return { tone: 'ok', state: 'Quiet', sub: im.failed7d > 0 ? `${im.failed7d} failed this week` : 'no failures this week' }
  })()

  const emailTile = (() => {
    const e = data.emails
    if (!e) return { tone: 'none', state: '—', sub: 'couldn’t read' }
    if (!e.tracked) return { tone: 'none', state: 'Not tracked yet', sub: 'notification_log.sql' }
    if ((e.failed || 0) > 0) return { tone: 'warn', state: `${e.failed} failed`, sub: `${e.total ?? 0} sent over 24h` }
    return { tone: 'ok', state: 'Sending', sub: `${e.total ?? 0} accepted · 0 failed` }
  })()

  const look = data.needsALook || []
  // Quiet locations are the absence signal — only meaningful at 'all'. They
  // ride the look-list ('quiet' rows); surface the count in the activity line
  // so it stays visible even when other rows fill the 3-row cap.
  const quietCount = look.filter(item => item.key === 'quiet').length
  const a = data.activity
  const fbItems = (data.feedback?.newest) || []
  const fbShown = fbItems.slice(0, 3)
  // Overflow beyond the three shown cells; folds into the fourth cell so three
  // items take two rows, not three. open is the tenant-wide total (newest is
  // capped at 3 by the API), so the remainder is open − shown.
  const fbMore = Math.max(0, (typeof data.feedback?.open === 'number' ? data.feedback.open : fbShown.length) - fbShown.length)
  const openFull = onOpenFull || (() => {})

  const twoCol = { display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr' }

  return (
    <div style={{ display: 'grid', gap: '10px' }}>
      {/* ── verdict banner — ONE line: dot + title + · reason, digest pushed right ── */}
      <div style={{
        borderRadius: T.radius.control, padding: '9px 13px',
        display: 'flex', gap: '8px', alignItems: 'center',
        background: bannerFamily.bg, color: bannerFamily.text,
      }}>
        <span aria-hidden="true" style={{ width: '10px', height: '10px', borderRadius: T.radius.round, background: bannerDot, flexShrink: 0 }} />
        <span style={{ fontSize: '14px', fontWeight: 600, flexShrink: 0 }}>
          {v.level === 'green' ? 'System healthy' : v.level === 'red' ? 'Needs attention' : 'A few things to look at'}
        </span>
        <span style={{ fontSize: '13px', fontWeight: 500, opacity: 0.9, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          · {bannerCopy}
        </span>
        <span style={{ fontSize: '12px', flexShrink: 0, whiteSpace: 'nowrap', color: digestLine.warn ? T.state.warning.fg : bannerFamily.text, opacity: digestLine.warn ? 1 : 0.85 }}>
          {digestLine.text}
        </span>
      </div>

      {/* ── status tiles — stay FOUR ACROSS (four systems, four states) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px' }}>
        <Tile label="Jobber" tone={jobberTile.tone} state={jobberTile.state} sub={jobberTile.sub} />
        <Tile label="Webhooks · 24h" tone={webhookTile.tone} state={webhookTile.state} sub={webhookTile.sub} />
        <Tile label="Imports" tone={importTile.tone} state={importTile.state} sub={importTile.sub} />
        <Tile label="Emails · 24h" tone={emailTile.tone} state={emailTile.state} sub={emailTile.sub} />
      </div>

      {/* ── needs a look + last 24 hours, side by side (half width each) ── */}
      <div style={{ ...twoCol, gap: '10px', alignItems: 'start' }}>
        {/* needs a look — self-clearing tier, 3 rows max, each taps through */}
        <Card>
          <SectionLabel count={look.length}>Needs a look</SectionLabel>
          {look.length === 0 ? (
            <p style={{ fontSize: '13px', color: T.ink.quiet, margin: '9px 0 1px' }}>Nothing needs a look.</p>
          ) : (
            <div style={{ display: 'grid', gap: '5px', marginTop: '9px' }}>
              {look.slice(0, 3).map((item, i) => (
                <button
                  key={`${item.key}-${i}`}
                  onClick={openFull}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '8px', textAlign: 'left', width: '100%',
                    background: T.family.amber.bg, color: T.family.amber.text, border: 'none', cursor: 'pointer',
                    borderRadius: T.radius.control, padding: '7px 10px', fontFamily: 'inherit',
                    fontSize: '12px', fontWeight: 500,
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>{item.label}</span>
                  <span aria-hidden="true" style={{ opacity: 0.7 }}>›</span>
                </button>
              ))}
              {look.length > 3 && (
                <button style={{ ...linkStyle, justifySelf: 'start', marginTop: '1px' }} onClick={openFull}>
                  {look.length - 3} more →
                </button>
              )}
            </div>
          )}
        </Card>

        {/* last 24 hours — six counts in a 3×2 grid; quiet line at the bottom */}
        <Card>
          <SectionLabel>Last 24 hours</SectionLabel>
          {a ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', marginTop: '9px' }}>
                <Stat value={a.leadsIn} label="leads in" />
                <Stat value={a.requests} label="requests" />
                <Stat value={a.quotesSent} label="quotes sent" />
                <Stat value={a.jobsBooked} label="jobs booked" />
                <Stat value={a.invoicesPaid} label="invoices paid" />
                <Stat value={a.wonCount != null ? fmtMoney(a.wonValue) : null} label={`won${a.wonCount ? ` · ${a.wonCount}` : ''}`} />
              </div>
              <p style={{ fontSize: '12px', color: quietCount > 0 ? T.state.warning.fg : T.ink.quiet, marginTop: '9px', paddingTop: '8px', borderTop: T.border.divider }}>
                {quietCount > 0
                  ? `${quietCount} location${quietCount === 1 ? '' : 's'} quiet — no new leads in 7 days`
                  : 'Every active location saw a lead in the last 7 days.'}
              </p>
            </>
          ) : (
            <p style={{ fontSize: '13px', color: T.ink.quiet, margin: '9px 0 1px' }}>Couldn’t read activity.</p>
          )}
        </Card>
      </div>

      {/* ── feedback — full width, split internally into two columns so three
          items take two rows; "N more →" rides the fourth cell ── */}
      <Card>
        <SectionLabel
          count={data.feedback?.open ?? null}
          right={fbShown.length > 0 ? <button style={linkStyle} onClick={openFull}>View all →</button> : null}
        >
          Feedback
        </SectionLabel>
        {fbShown.length === 0 ? (
          <p style={{ fontSize: '13px', color: T.ink.quiet, margin: '9px 0 1px' }}>No open reports.</p>
        ) : (
          <div style={{ ...twoCol, gap: '6px 16px', marginTop: '9px' }}>
            {fbShown.map((item) => (
              <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, fontSize: '13px', color: T.ink.primary }}>
                <StatusChip label={item.type === 'bug' ? 'bug' : 'feature'} styleKey={item.type === 'bug' ? 'red' : 'blue'} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
                <span style={{ ...SECTION_COUNT, whiteSpace: 'nowrap' }}>
                  {item.locationName ? `${item.locationName} · ` : ''}{fmtAgo(item.createdAt)}
                </span>
              </div>
            ))}
            {fbMore > 0 && (
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <button style={linkStyle} onClick={openFull}>{fbMore} more →</button>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* ── the deep view stays the full System Health screen ── */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button style={linkStyle} onClick={openFull}>View full system health →</button>
      </div>
    </div>
  )
}
