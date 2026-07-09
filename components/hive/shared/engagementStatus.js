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

// Compact local wall-clock time: '7pm' / '10:30am' — minutes only when
// non-zero, lowercase am/pm. scheduled_at is stored UTC; local getters
// render the viewer's zone (beta chunk is ssr:false, so no server/client
// mismatch). THE time treatment for chips + panel timeline.
export const fmtTime = (d) => {
  if (!d) return null
  const dt = new Date(d)
  if (isNaN(dt)) return null
  const h24 = dt.getHours(), m = dt.getMinutes()
  const ap = h24 >= 12 ? 'pm' : 'am'
  const h = h24 % 12 || 12
  return m ? `${h}:${String(m).padStart(2, '0')}${ap}` : `${h}${ap}`
}

// Full prose date — 'July 7, 2026' (full month name). For the roomy
// header/subtitle spots (opened / client since / inquired lines); the
// vitals strip and Timeline rows KEEP the compact formatInboxAge/
// formatInboxFuture treatment — deliberate, not an inconsistency.
const FULL_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
export const formatFullDate = (d) => {
  if (!d) return null
  const dt = new Date(d)
  if (isNaN(dt)) return null
  return `${FULL_MONTHS[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`
}

// 'Jul 6, 7pm' — compact date+time for chips.
export const fmtShortTime = (d) => {
  const date = fmtShort(d)
  if (!date) return null
  const time = fmtTime(d)
  return time ? `${date}, ${time}` : date
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

// LINKED vs LOCAL — THE gate for manual pipeline control. "Linked" =
// the engagement has ANY Jobber child record (the inverse of the
// panel's canSendToJobber "zero child records" check, and the same
// derivation family as jobberHref). Linked engagements get their
// pipeline stage from the webhook/import derivation; only LOCAL
// engagements (no children → derivation always says Request) keep the
// Advance button and pipeline drag. NOT a stored flag — always derived.
// Accepts either a board row or the panel's fetched children object
// (both carry the child arrays under the same keys).
export const ENGAGEMENT_CHILD_KEYS = ['service_requests', 'quotes', 'jobs', 'invoices', 'assessments']
export function isJobberLinked(rec) {
  return ENGAGEMENT_CHILD_KEYS.some(k => ((rec || {})[k] || []).length > 0)
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

// Spelled-out age (LOCKED idiom update 2026-07-04): '5 Minutes' /
// '2 Hours' / '42 Days', singular-correct. ONE formatter for board day
// counters, list ACTIVITY, inbox last-touch, directory detail lines —
// no per-surface drift. relAge keeps its name so consumers inherit.
const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`
export function formatAge(t, nowMs = Date.now()) {
  if (!t) return '—'
  const mins = Math.max(0, Math.floor((nowMs - t) / 60000))
  if (mins < 60) return plural(mins, 'Minute')
  const hours = Math.floor(mins / 60)
  if (hours < 24) return plural(hours, 'Hour')
  return plural(Math.floor(hours / 24), 'Day')
}
export const relAge = formatAge
export const formatDayCount = (n) => plural(n, 'Day')

// Adaptive "date · relative" for the Inbox row's age slot — shows both,
// but ADAPTS so it never reads redundant or useless:
//   < 24h            → relative only ('45 min ago' / '3 hours ago' —
//                      the date is today, printing it adds nothing)
//   1–30d, this year → 'Jun 5 · 29d ago' (compact abbreviated relative)
//   > 30d, this year → 'Apr 21' (relative past ~a month is low-value)
//   prior year       → 'Dec 12, 2025' (full date, no relative)
// Split into parts so the row can style the anchor (--text-secondary)
// and the '· hint' (--text-muted) separately; formatInboxAge joins them
// for plain-string consumers and tests. All relative numbers rounded.
const AGE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function formatInboxAgeParts(created, nowMs = Date.now()) {
  const t = typeof created === 'number' ? created : (created ? new Date(created).getTime() : 0)
  if (!t) return { anchor: '—', hint: null }
  const ms = Math.max(0, nowMs - t)
  if (ms < 86400000) {
    const mins = Math.round(ms / 60000)
    if (mins < 1) return { anchor: 'just now', hint: null }
    if (mins < 60) return { anchor: `${mins} min ago`, hint: null }
    // clamp: 23.6h would otherwise round up to '24 hours ago'
    const hours = Math.min(23, Math.round(ms / 3600000))
    return { anchor: `${hours} hour${hours === 1 ? '' : 's'} ago`, hint: null }
  }
  const d = new Date(t)
  const dateShort = `${AGE_MONTHS[d.getMonth()]} ${d.getDate()}`
  if (d.getFullYear() !== new Date(nowMs).getFullYear()) {
    return { anchor: `${dateShort}, ${d.getFullYear()}`, hint: null }
  }
  const days = Math.round(ms / 86400000)
  if (days <= 30) return { anchor: dateShort, hint: `${Math.max(1, days)}d ago` }
  return { anchor: dateShort, hint: null }
}
export function formatInboxAge(created, nowMs = Date.now()) {
  const { anchor, hint } = formatInboxAgeParts(created, nowMs)
  return hint ? `${anchor} · ${hint}` : anchor
}

// The FUTURE mirror of formatInboxAgeParts — same adaptive tiers, phrased
// forward ('in 45 min' / 'Jul 9 · in 5d') so the timeline's upcoming rows
// read consistent with the Inbox's past rows:
//   < 24h ahead        → relative only ('in 45 min' / 'in 3 hours')
//   1–30d, this year   → 'Jul 9 · in 5d'
//   > 30d, this year   → 'Aug 21' (relative past ~a month is low-value)
//   later year         → 'Jan 12, 2027' (full date, no relative)
export function formatInboxFutureParts(when, nowMs = Date.now()) {
  const t = typeof when === 'number' ? when : (when ? new Date(when).getTime() : 0)
  if (!t) return { anchor: '—', hint: null }
  const ms = Math.max(0, t - nowMs)
  if (ms < 86400000) {
    const mins = Math.round(ms / 60000)
    if (mins < 1) return { anchor: 'now', hint: null }
    if (mins < 60) return { anchor: `in ${mins} min`, hint: null }
    // clamp: 23.6h would otherwise round up to 'in 24 hours'
    const hours = Math.min(23, Math.round(ms / 3600000))
    return { anchor: `in ${hours} hour${hours === 1 ? '' : 's'}`, hint: null }
  }
  const d = new Date(t)
  const dateShort = `${AGE_MONTHS[d.getMonth()]} ${d.getDate()}`
  if (d.getFullYear() !== new Date(nowMs).getFullYear()) {
    return { anchor: `${dateShort}, ${d.getFullYear()}`, hint: null }
  }
  const days = Math.round(ms / 86400000)
  if (days <= 30) return { anchor: dateShort, hint: `in ${Math.max(1, days)}d` }
  return { anchor: dateShort, hint: null }
}
export function formatInboxFuture(when, nowMs = Date.now()) {
  const { anchor, hint } = formatInboxFutureParts(when, nowMs)
  return hint ? `${anchor} · ${hint}` : anchor
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
    return { label: longForm ? `Nurturing · Day ${d} of 90` : `Nurturing · ${formatDayCount(d)}`, styleKey: 'nurturing' }
  }
  const quotes = e.quotes || []
  const jobs = e.jobs || []
  const invoices = e.invoices || []

  switch (e.stage) {
    case 'Request': {
      // A scheduled FUTURE assessment outranks the request-age chip —
      // the next concrete step is on the calendar. A past-dated
      // assessment that never resolved falls back to the age chip (the
      // data can't distinguish held-awaiting-quote from no-show, so
      // 'Missed?' would accuse; the age amber surfaces staleness anyway).
      const nextAssess = (e.assessments || [])
        .filter(a => !a.completed_at)
        .map(a => ts(a.scheduled_at)).filter(t => t > nowMs)
        .sort((a, b) => a - b)[0]
      if (nextAssess) return { label: `Assessment · ${fmtShortTime(nextAssess)}`, styleKey: 'scheduled' }
      const age = daysSince(e.created_at, nowMs)
      if (age >= 21) return { label: `Requested · ${formatDayCount(age)}`, styleKey: 'amber' }
      return { label: age === 0 ? 'Requested Today' : `Requested · ${formatDayCount(age)}`, styleKey: 'Request' }
    }
    case 'Estimate': {
      if (quotes.some(q => q.status === 'approved')) return { label: 'Approved', styleKey: 'approved' }
      if (quotes.some(q => q.status === 'changes_requested')) return { label: 'Changes Requested', styleKey: 'changes_requested' }
      const latest = quotes.reduce((a, q) => Math.max(a, ts(q.sent_at)), 0)
      const when = latest ? fmtShort(latest) : null
      return { label: when ? `Sent ${when}` : 'Sent', styleKey: 'sent' }
    }
    case 'Job in Progress': {
      const active = jobs.filter(j => !j.completed_at && !(j.status || '').includes('complet'))
      const inProg = active.find(j => j.status === 'in_progress' || j.status === 'active')
      if (inProg) return { label: 'In Progress', styleKey: 'in_progress' }
      const starts = active
        .map(j => ts(j.scheduled_start)).filter(t => t > 0)
        .sort((a, b) => a - b)
      const nextFuture = starts.find(t => t > nowMs)
      if (nextFuture) return { label: `Scheduled ${fmtShort(nextFuture)}`, styleKey: 'scheduled' }
      if (starts.length > 0) return { label: 'In Progress', styleKey: 'in_progress' }
      return { label: 'Upcoming', styleKey: 'upcoming' }
    }
    case 'Final Processing': {
      const owing = Number(e.balance_owing) || 0
      if (owing > 0) return { label: `Owes ${fmtMoney(owing)}`, styleKey: 'owing' }
      if (invoices.length === 0) return { label: 'Never Invoiced', styleKey: 'never_invoiced' }
      return { label: 'Paid', styleKey: 'paid' }
    }
    case 'Closed Won':
    case 'Closed Lost': {
      const raw = (e.closed_reason || '').replace(/_/g, ' ')
      const label = raw ? raw.replace(/\b\w/g, c => c.toUpperCase()).replace(/ (On|Of|The|With) /g, m => m.toLowerCase()) : e.stage
      return { label, styleKey: 'gray' }
    }
    default:
      return null
  }
}
