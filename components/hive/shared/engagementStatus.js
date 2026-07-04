// components/hive/shared/engagementStatus.js
// ─────────────────────────────────────────────────────────────
// PURE module — the single within-stage status derivation consumed by
// BOTH EngagementBoard cards and EngagementList rows, so the two lenses
// can never disagree. Also owns the shared display helpers (junk-title
// fallback, value, activity age). Zero imports beyond none — safe in
// any bundle (§8.5 pure-module rule).
// ─────────────────────────────────────────────────────────────

export const fmtMoney = (n) => '$' + Math.round(Number(n) || 0).toLocaleString()

export const fmtShort = (d) => {
  if (!d) return null
  const dt = new Date(d)
  if (isNaN(dt)) return null
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const ts = (v) => {
  if (!v) return 0
  const t = new Date(v).getTime()
  return isNaN(t) ? 0 : t
}

export const daysSince = (d, nowMs = Date.now()) =>
  Math.max(0, Math.floor((nowMs - new Date(d).getTime()) / 86400000))

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

// Junk-length Jobber titles ("(L)", "(M)") fall through to the generic
// fallback — a ≤3-character title reads as data noise.
export function displayTitle(e) {
  const t = (e.title || '').trim()
  if (t.length > 3) return t
  const d = e.created_at ? new Date(e.created_at) : new Date()
  return `Engagement – ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

// Card/row value: real money once invoiced, best quote before that.
// Returns a number or null (callers fmtMoney / em-dash).
export function engagementValue(e) {
  const invoiced = Number(e.total_invoiced) || 0
  if (invoiced > 0) return invoiced
  const quoted = Math.max(0, ...(e.quotes || []).map(q => Number(q.total) || 0))
  return quoted > 0 ? quoted : null
}

// Last meaningful activity: most recent child timestamp, falling back to
// stage_entered_at (which the backfill set to the chain's last activity —
// historically honest) and only then updated_at (backfill-stamped for
// every historical row, so it would read uniformly fresh).
export function lastActivityTs(e) {
  const candidates = [
    ...(e.quotes || []).flatMap(q => [ts(q.approved_at), ts(q.sent_at)]),
    ...(e.jobs || []).flatMap(j => [ts(j.completed_at), ts(j.scheduled_start)]),
    ...(e.invoices || []).flatMap(i => [ts(i.paid_at), ts(i.issued_at)]),
    ts(e.closed_at),
    ts(e.stage_entered_at),
  ].filter(t => t > 0 && t <= Date.now() + 86400000) // ignore far-future schedule dates
  if (candidates.length > 0) return Math.max(...candidates)
  return ts(e.stage_entered_at) || ts(e.updated_at) || ts(e.created_at)
}

// Relative age for the ACTIVITY column: 42m / 2h / 3d / 42d.
export function relAge(t, nowMs = Date.now()) {
  if (!t) return '—'
  const mins = Math.max(0, Math.floor((nowMs - t) / 60000))
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

// ── engagement filters (shared by board + list, owned by HiveShell) ──
// Pure predicate so every consumer (both lenses + the shell's counter)
// agrees by construction.

export const ENGAGEMENT_FILTER_DEFAULTS = {
  stages: [],        // [] = all open stages
  statuses: [],      // within-stage styleKeys
  min: '', max: '',  // value range ($)
  age: null,         // quiet: null | 7 | 30 | 90
  owing: false,
  repeat: false,
  fresh: false,      // new clients only: first engagement, <30d
  foundedBy: [],     // request | quote | job | manual
}

export function engagementFilterCount(f) {
  return (f.stages.length ? 1 : 0) + (f.statuses.length ? 1 : 0) +
    (f.min ? 1 : 0) + (f.max ? 1 : 0) + (f.age ? 1 : 0) +
    (f.owing ? 1 : 0) + (f.repeat ? 1 : 0) + (f.fresh ? 1 : 0) +
    (f.foundedBy.length ? 1 : 0)
}

export function passesEngagementFilters(e, f, nowMs = Date.now(), { ignoreStages = false } = {}) {
  if (!ignoreStages && f.stages.length && !f.stages.includes(e.stage)) return false
  if (f.statuses.length) {
    const k = deriveStatusChip(e, { nowMs })?.styleKey
    if (!k || !f.statuses.includes(k)) return false
  }
  const v = engagementValue(e) ?? 0
  if (f.min && v < Number(f.min)) return false
  if (f.max && v > Number(f.max)) return false
  if (f.age && (nowMs - lastActivityTs(e)) < f.age * 86400000) return false
  if (f.owing && !(Number(e.balance_owing) > 0)) return false
  if (f.repeat && !(e.repeat_count > 1)) return false
  if (f.fresh && !(e.repeat_count === 1 && (nowMs - new Date(e.created_at).getTime()) < 30 * 86400000)) return false
  if (f.foundedBy.length && !f.foundedBy.includes(e.founded_by)) return false
  return true
}

// Within-stage status chip (THE derivation — board cards + list rows):
//   Request          → request age (teal; amber at day >= 21 as pre-nurture cue)
//   Estimate         → latest quote state; 'sent' is the neutral default
//   Job in Progress  → active job state / next FUTURE scheduled date
//                      (recurring Jobber jobs keep stale past starts —
//                      a past start on an uncompleted job is in progress)
//   Final Processing → owing $X (red) | never invoiced (amber) | paid
//   terminal         → closed_reason, muted
// A live nurture clock (nurture_started_at, step 5) overrides everything.
// opts.longForm renders the mockup's list phrasing ('nurturing · day N of 90').
export function deriveStatusChip(e, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now()
  const longForm = !!opts.longForm

  if (e.nurture_started_at) {
    const d = daysSince(e.nurture_started_at, nowMs)
    return { label: longForm ? `nurturing · day ${d} of 90` : `nurturing · d${d}`, styleKey: 'nurturing' }
  }
  const quotes = e.quotes || []
  const jobs = e.jobs || []
  const invoices = e.invoices || []

  switch (e.stage) {
    case 'Request': {
      const age = daysSince(e.created_at, nowMs)
      if (age >= 21) return { label: `requested · d${age}`, styleKey: 'amber' }
      return { label: age === 0 ? 'requested today' : `requested · d${age}`, styleKey: 'Request' }
    }
    case 'Estimate': {
      if (quotes.some(q => q.status === 'approved')) return { label: 'approved', styleKey: 'approved' }
      if (quotes.some(q => q.status === 'changes_requested')) return { label: 'changes requested', styleKey: 'changes_requested' }
      const latest = quotes.reduce((a, q) => Math.max(a, ts(q.sent_at)), 0)
      const when = latest ? fmtShort(latest) : null
      return { label: when ? `sent ${when}` : 'sent', styleKey: 'sent' }
    }
    case 'Job in Progress': {
      const active = jobs.filter(j => !j.completed_at && !(j.status || '').includes('complet'))
      const inProg = active.find(j => j.status === 'in_progress' || j.status === 'active')
      if (inProg) return { label: 'in progress', styleKey: 'in_progress' }
      const starts = active
        .map(j => ts(j.scheduled_start)).filter(t => t > 0)
        .sort((a, b) => a - b)
      const nextFuture = starts.find(t => t > nowMs)
      if (nextFuture) return { label: `scheduled ${fmtShort(nextFuture)}`, styleKey: 'scheduled' }
      if (starts.length > 0) return { label: 'in progress', styleKey: 'in_progress' }
      return { label: 'upcoming', styleKey: 'upcoming' }
    }
    case 'Final Processing': {
      const owing = Number(e.balance_owing) || 0
      if (owing > 0) return { label: `owing ${fmtMoney(owing)}`, styleKey: 'owing' }
      if (invoices.length === 0) return { label: 'never invoiced', styleKey: 'never_invoiced' }
      return { label: 'paid', styleKey: 'paid' }
    }
    case 'Closed Won':
    case 'Closed Lost': {
      const r = (e.closed_reason || '').replace(/_/g, ' ')
      return { label: r || e.stage.toLowerCase(), styleKey: 'gray' }
    }
    default:
      return null
  }
}
