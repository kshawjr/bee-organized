// components/hive/EngagementPanel.jsx
// ─────────────────────────────────────────────────────────────
// The ONE-DEAL work card — v2 layout (card-restore build 2, Kevin's
// 7/10 mockup session; 840px desktop modal):
//   MASTHEAD (persistent above the tabs, every tab):
//     line 1 — client name (h2, the ONE place the name renders) +
//              location + Repeat chip (prior engagements exist);
//              engagement VALUE right-aligned, tabular
//     line 2 — 'View profile' accent link (→ onOpenClient) · opened
//              {full date} · founded by {…}
//     line 3 — engagement title (displayTitle — v2 RENDERS it again) +
//              stage chip + 'N days in stage' muted (Build 1)
//     line 4 — Type MetaSelect (deal-scoped; its ONE home)
//   ClosedSummary (closed) / DRIP BANNER (live or paused drip only —
//     'Drip · step N of M · next {date}'; hidden once stopped/completed/
//     absent per Kevin's gone-after-Jobber rule) ride the slot under
//     the masthead.
//   tabs — Overview · Timeline (count) · Files
//   Overview — TWO columns (stacks under ~700px):
//     LEFT  Jobber records as a MILESTONE CHECKLIST on a vertical rail
//           (design-system pass 7/11): done = filled accent check +
//           date + ↗ deep link; current stage's family = accent ring/
//           amber dot + status word; not-yet-reached steps render as
//           hollow muted placeholders so the full expected arc
//           (Request → Assessment* → Quote → Job → Invoice) is visible.
//           The arc derives from milestoneFamilies (stageConfig — the
//           stage machine's canonical order); the Assessment step
//           appears only when the engagement carries assessment records
//           (creation_type is never persisted — child rows are the one
//           honest signal). Plus the invoice detail inset (INV- number/
//           dates + honest deep-link actions).
//     RIGHT description (EditableDesc) + engagement-scoped activity +
//           composer
//   action bar — PINNED (sticky): Call · Log touchpoint · (Send to
//     Jobber, founded-not-sent only) · Open in Jobber · Close… (the
//     same shared CloseEngagementConfirm inline on Overview — moved out
//     of the ··· menu in build 2)
// Fetches GET /api/engagements/:id on open (board rows stay
// lightweight; `seed` renders the shell synchronously).
//
// PERSON-vs-DEAL (Kevin's split): contact/address/referrer/source and
// the pinned buzz are PERSON-scoped — they live on ClientProfile (one
// 'View profile' tap away) and were removed from this card in build 2.
// Project type is DEAL-scoped — masthead only, never on the profile.
//
// NO manual stage mover (decision 2026-07-10, Kevin): all business
// flows through Jobber — a local engagement's stage assertion is
// always fiction, so pipeline stages move ONLY via the Jobber
// derivation (webhooks / import / drift recovery). The Advance button
// was removed 7/10; the only human stage write left is the terminal
// Close (won/lost) via the ··· menu.
//
// Desktop: centered modal. Mobile: bottom sheet. Beta chunk.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect } from 'react'
import useIsMobile from './shared/useIsMobile'
import { isTerminal, stageDisplayLabel, CHIP_STYLES, STAGE_RECORD_FAMILY, milestoneFamilies } from './shared/stageConfig'
import StatusChip from '@/components/ui/StatusChip'
import { IconInbox, IconFileText, IconHammer, IconFileInvoice, IconCheck, IconPhone, IconExternalLink, IconCalendar, IconSend, IconPaperclip } from '@/components/ui/icons'
import NotesStream from './NotesStream'
import EditableDesc from './EditableDesc'
import OverlayShell from './OverlayShell'
import MetaSelect from './MetaSelect'
import Timeline from './shared/Timeline'
import CardTabs from './shared/CardTabs'
import InitialsAvatar from './shared/InitialsAvatar'
import { MicroLabel, quietBtn, ActionRow, actionBtn } from './shared/cardKit'
import CloseEngagementConfirm from './shared/CloseEngagementConfirm'
import ClosedSummary from './shared/ClosedSummary'
import { fmtTime, fmtShort, engagementValue, displayTitle, formatFullDate, invoiceNumber, daysInStage } from './shared/engagementStatus'
import { recordJobberUrl } from './shared/jobberLinks'
import { T } from './shared/tokens'

const fmtMoney = (n) => '$' + Math.round(Number(n) || 0).toLocaleString()
const fmtDate = (d) => {
  if (!d) return null
  const dt = new Date(d)
  if (isNaN(dt)) return null
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// Milestone family display meta — leading glyphs KEEP their family
// colors (they encode record type); node/state colors carry the arc.
const FAMILY_META = {
  request:    { label: 'Request',    Icon: IconInbox,       glyph: T.accent.deep },
  assessment: { label: 'Assessment', Icon: IconCalendar,    glyph: T.state.info.deep },
  quote:      { label: 'Quote',      Icon: IconFileText,    glyph: T.state.info.deep },
  job:        { label: 'Job',        Icon: IconHammer,      glyph: T.state.info.deep },
  invoice:    { label: 'Invoice',    Icon: IconFileInvoice, glyph: T.state.danger.fg },
}

// The rail node — the milestone checklist's three states:
//   done    — filled accent circle, white check
//   current — raised circle, accent ring, amber dot (the eye lands here)
//   future  — hollow muted circle (not yet reached)
function MilestoneNode({ kind }) {
  if (kind === 'done') {
    return (
      <span aria-label="Milestone done" style={{
        width: '18px', height: '18px', borderRadius: T.radius.round, background: T.accent.fg,
        color: T.accent.onFill, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <IconCheck size={11} />
      </span>
    )
  }
  if (kind === 'current') {
    return (
      <span aria-label="Milestone current" style={{
        width: '18px', height: '18px', borderRadius: T.radius.round, background: T.surface.raised,
        border: `2px solid ${T.accent.fg}`, boxSizing: 'border-box',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <span style={{ width: '6px', height: '6px', borderRadius: T.radius.round, background: T.scope.ringAmber }} />
      </span>
    )
  }
  return (
    <span aria-label="Milestone upcoming" style={{
      width: '18px', height: '18px', borderRadius: T.radius.round, background: 'transparent',
      border: `1.5px solid ${T.hairline.strong}`, boxSizing: 'border-box', flexShrink: 0,
    }} />
  )
}

// One milestone rail row. Real records carry primary/secondary/state/
// href (Build-1 ↗ deep links); future placeholders carry only the
// muted family label — no date, no state (the arc shows what's ahead,
// never invents when). `connectorDashed` projects the segment INTO the
// not-yet-real region, matching the Timeline's dashed-future idiom.
function MilestoneRow({ kind, primary, secondary = null, state = null, href = null, Icon, glyph, last = false, connectorDashed = false }) {
  const future = kind === 'future'
  return (
    <div style={{ display: 'flex', gap: '10px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '18px', flexShrink: 0 }}>
        <MilestoneNode kind={kind} />
        {!last && (
          <span aria-hidden style={{
            flex: 1, width: 0, minHeight: '8px', marginTop: '2px', marginBottom: '2px',
            borderLeft: `1px ${connectorDashed ? 'dashed' : 'solid'} ${T.hairline.control}`,
          }} />
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'flex-start', gap: '8px', paddingBottom: last ? 0 : '14px' }}>
        <span style={{ fontSize: '13px', flexShrink: 0, width: '18px', textAlign: 'center', color: future ? T.ink.quiet : glyph, lineHeight: '18px' }}>
          <Icon size={14} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: '13px', fontWeight: 500, color: future ? T.ink.quiet : T.ink.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{primary}</p>
          {secondary && <p style={{ fontSize: '11px', color: T.ink.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{secondary}</p>}
        </div>
        {state && (
          <span style={{ flexShrink: 0, fontSize: state.check ? '14px' : '12px', fontWeight: 500, color: state.color, whiteSpace: 'nowrap', lineHeight: '18px' }}>
            {state.check ? <IconCheck size={14} /> : state.label}
          </span>
        )}
        {href && (
          <a className="bee-contact-link" href={href} target="_blank" rel="noreferrer" aria-label="Open in Jobber"
            onClick={e => e.stopPropagation()}
            style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', color: T.ink.muted, lineHeight: '18px' }}>
            <IconExternalLink size={12} />
          </a>
        )}
      </div>
    </div>
  )
}

export default function EngagementPanel({ engagementId, seed = null, people = [], onClose, onOpenClient = () => {}, onChanged = () => {}, onLeadPatched = () => {}, onPartnerCreated = () => {}, onSendToJobber = null, setToast = () => {}, lookupOptions = { sources: [], projectTypes: [] } }) {
  const [data, setData] = useState(null)
  const [loadErr, setLoadErr] = useState(null)
  const [tab, setTab] = useState('overview')
  const [touchOpen, setTouchOpen] = useState(false)
  const [touchMethod, setTouchMethod] = useState('call')
  const [touchNote, setTouchNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)
  const nowMs = Date.now()

  const isMobile = useIsMobile()

  useEffect(() => {
    let dead = false
    setData(null); setLoadErr(null)
    fetch(`/api/engagements/${engagementId}`)
      .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`); return r.json() })
      .then(d => {
        if (dead) return
        setData(d)
        // The GET route drift-recovers linked engagements on open (a
        // swallowed webhook failure can leave stage stale) — when the
        // stage it returns differs from the board row we opened from,
        // push the correction back so the board doesn't stay stale.
        if (seed?.stage && d?.engagement?.stage && d.engagement.stage !== seed.stage) {
          onChanged(engagementId, { stage: d.engagement.stage })
        }
      })
      .catch(e => { if (!dead) setLoadErr(String(e.message || e)) })
    return () => { dead = true }
  }, [engagementId])

  const eng = data?.engagement ?? seed
  const children = data?.children ?? { service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [], notes: [], touchpoints: [] }
  const client = data?.client ?? null

  async function patchEngagement(body, okMsg) {
    setBusy(true)
    try {
      const res = await fetch(`/api/engagements/${engagementId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setData(d => d ? { ...d, engagement: { ...d.engagement, ...(body.title ? { title: j.title } : {}), ...(body.stage ? { stage: j.stage } : {}), ...(body.description !== undefined ? { description: j.description ?? null } : {}), ...(body.project_type !== undefined ? { project_type: j.project_type ?? null } : {}) } } : d)
      onChanged(engagementId, { ...(body.title ? { title: j.title } : {}), ...(body.stage ? { stage: j.stage } : {}) })
      if (okMsg) setToast({ kind: 'success', msg: okMsg })
      return true
    } catch (e) {
      setToast({ kind: 'error', msg: `Save failed: ${e.message}` })
      return false
    } finally {
      setBusy(false)
    }
  }

  // Engagement note (kind='job', anchored to THIS engagement) — posted
  // from the shared NotesStream composer.
  async function addEngagementNote(text) {
    if (!text || !client) return
    try {
      const res = await fetch('/api/lead-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: client.id, kind: 'job', text, engagement_id: engagementId }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setData(d => d ? { ...d, children: { ...d.children, notes: [j.note, ...(d.children.notes || [])] } } : d)
    } catch (e) {
      setToast({ kind: 'error', msg: `Note failed: ${e.message}` })
    }
  }

  async function logTouchpoint() {
    if (!client) return
    setBusy(true)
    try {
      const res = await fetch('/api/touchpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead_id: client.id,
          kind: 'reach_out',
          label: 'Reach-out',
          method: touchMethod,
          notes: touchNote.trim() || null,
          engagement_id: engagementId,
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setTouchNote(''); setTouchOpen(false)
      if (j.touchpoint) {
        setData(d => d ? { ...d, children: { ...d.children, touchpoints: [{ ...j.touchpoint, user_label: 'You' }, ...(d.children.touchpoints || [])] } } : d)
      }
      setToast({ kind: 'success', msg: 'Touchpoint logged' })
    } catch (e) {
      setToast({ kind: 'error', msg: `Touchpoint failed: ${e.message}` })
    } finally { setBusy(false) }
  }

  // Engagement-SCOPED recent slice: this engagement's notes + touches.
  const activity = [
    ...(children.notes || []).map(n => ({ t: 'note', ts: n.created_at, ...n })),
    ...(children.touchpoints || []).map(tp => ({ t: 'touch', ts: tp.occurred_at, ...tp })),
  ].sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 8)

  // Deep link: latest job → quote → request (whatever Jobber has).
  const jobberHref = (() => {
    const jobs = children.jobs, quotes = children.quotes, srs = children.service_requests
    return jobs[jobs.length - 1]?.job_url || quotes[quotes.length - 1]?.quote_url || srs[srs.length - 1]?.request_url || null
  })()

  // Founded-but-not-sent (the decoupled-founding case): NO work records
  // at all → Send to Jobber, carrying engagementId so the request
  // attaches HERE (never a second engagement / second lead).
  const canSendToJobber = !!onSendToJobber && !!data && eng && !isTerminal(eng.stage) &&
    children.service_requests.length === 0 && children.quotes.length === 0 &&
    children.jobs.length === 0 && children.invoices.length === 0 &&
    (children.assessments || []).length === 0

  // The stage's record family — single-homed in stageConfig (the same
  // map the milestone arc derives from). Terminal stages own nothing
  // ("current" implies motion; a closed deal has none).
  const currentType = eng && !isTerminal(eng.stage) ? STAGE_RECORD_FAMILY[eng.stage] ?? null : null

  // Trailing state per row — the one-accent rule: done is a filled
  // check, everything in motion (status words, scheduled dates, owing
  // figures) reads in THE accent; attention states keep amber, archived
  // reads muted.
  const DONE = { check: true, color: T.accent.fg }
  const quoteState = (q) =>
    q.status === 'approved' ? DONE
    : q.status === 'changes_requested' ? { label: 'changes requested', color: T.state.warning.deep }
    : q.status === 'archived' ? { label: 'archived', color: T.ink.muted }
    : { label: 'sent', color: T.accent.fg }
  const jobState = (j) =>
    (j.completed_at || (j.status || '').includes('complet')) ? DONE
    : j.scheduled_start ? { label: fmtDate(j.scheduled_start), color: T.accent.fg }
    : { label: (j.status && j.status !== 'unknown' ? j.status.replace('_', ' ') : 'upcoming'), color: T.accent.fg }
  const invoiceState = (i) =>
    i.status === 'paid' ? DONE
    : { label: `owing ${fmtMoney(i.balance_owing != null ? i.balance_owing : i.total)}`, color: T.accent.fg }

  // Masthead value — total_invoiced once real, best quote before that;
  // hidden (not '$0') when neither exists.
  const dealValue = eng ? engagementValue({ ...eng, quotes: children.quotes }) : null

  // Close-out (doc §4): the trigger lives in the ··· menu; the SHARED
  // human close flow (shared/CloseEngagementConfirm — same component +
  // write path as the board's drag-to-close) renders inline on
  // Overview, never a second modal.
  const closeConfirm = closeOpen && eng && (
    <CloseEngagementConfirm
      engagementId={engagementId}
      invoices={children.invoices || []}
      onCancel={() => setCloseOpen(false)}
      onClosed={(stage, j) => {
        setCloseOpen(false)
        setData(d => d ? { ...d, engagement: { ...d.engagement, stage: j.stage } } : d)
        onChanged(engagementId, { stage: j.stage })
        setTimeout(onClose, 900)
      }}
      setToast={setToast}
    />
  )

  // ── The milestone checklist rows (design-system pass 7/11) ────
  // The expected arc from the stage machine's canonical order; real
  // records render inside their family slot, families beyond the
  // current stage render as hollow placeholders (open engagements
  // only — a closed deal's unreached steps are history, not a path).
  const milestoneRows = (() => {
    if (!eng) return []
    const terminal = isTerminal(eng.stage)
    const hasAssessment = (children.assessments || []).length > 0
    const arc = milestoneFamilies({ hasAssessment })
    const currentIdx = currentType ? arc.indexOf(currentType) : -1

    const recordsFor = {
      request: children.service_requests.map(sr => ({
        key: sr.id,
        kind: currentType === 'request' ? 'current' : 'done',
        primary: `Request · ${fmtDate(sr.requested_at || sr.created_at) || '—'}`,
        secondary: sr.source ? `source: ${sr.source}` : null,
        state: currentType === 'request' ? { label: 'active', color: T.accent.fg } : DONE,
        href: recordJobberUrl('request', sr),
      })),
      assessment: (children.assessments || []).map(a => {
        const done = !!a.completed_at || a.status === 'completed'
        const future = new Date(a.scheduled_at || 0).getTime() > nowMs
        return {
          key: a.id,
          kind: done ? 'done' : future ? 'current' : 'future',
          primary: `Assessment · ${[fmtDate(a.scheduled_at), fmtTime(a.scheduled_at)].filter(Boolean).join(', ') || '—'}`,
          secondary: done && a.completed_at ? `completed ${fmtDate(a.completed_at)}` : null,
          state: done ? DONE : { label: 'Scheduled', color: future ? T.accent.fg : T.ink.muted },
          href: null,
        }
      }),
      quote: children.quotes.map(q => ({
        key: q.id,
        kind: currentType === 'quote' ? 'current' : 'done',
        primary: `Quote · ${fmtMoney(q.total)}`,
        secondary: [q.sent_at && `sent ${fmtDate(q.sent_at)}`, q.approved_at && `approved ${fmtDate(q.approved_at)}`].filter(Boolean).join(' · ') || null,
        state: quoteState(q),
        href: recordJobberUrl('quote', q),
      })),
      job: children.jobs.map(j => ({
        key: j.id,
        kind: currentType === 'job' ? 'current' : 'done',
        primary: `Job · ${j.title || 'Untitled'}${j.total != null ? ` · ${fmtMoney(j.total)}` : ''}`,
        secondary: [j.scheduled_start && `scheduled ${fmtDate(j.scheduled_start)}`, j.completed_at && `completed ${fmtDate(j.completed_at)}`].filter(Boolean).join(' · ') || null,
        state: jobState(j),
        href: recordJobberUrl('job', j),
      })),
      // '$X of $Y paid' rides the invoice row — the strip carries no
      // paid column, so this is where the paid detail lives.
      invoice: children.invoices.map(inv => ({
        key: inv.id,
        kind: currentType === 'invoice' ? 'current' : 'done',
        primary: `Invoice · ${fmtMoney(inv.total)}`,
        secondary: `${fmtMoney(inv.paid_amount != null ? inv.paid_amount : Math.max(0, (Number(inv.total) || 0) - (Number(inv.balance_owing) || 0)))} of ${fmtMoney(inv.total)} paid`,
        state: invoiceState(inv),
        href: recordJobberUrl('invoice', inv),
      })),
    }

    const rows = []
    arc.forEach((family, idx) => {
      const recs = recordsFor[family] || []
      if (recs.length > 0) {
        recs.forEach(r => rows.push({ family, ...r }))
        return
      }
      if (terminal) return // closed: unreached steps are not a path
      if (currentIdx >= 0 && idx === currentIdx) {
        // the stage is here but Jobber has no record yet (manual founding)
        rows.push({ family, key: `ph-${family}`, kind: 'current', primary: FAMILY_META[family].label, secondary: null, state: null, href: null })
        return
      }
      if (currentIdx >= 0 && idx > currentIdx) {
        // not yet reached — hollow placeholder, label only
        rows.push({ family, key: `ph-${family}`, kind: 'future', primary: FAMILY_META[family].label, secondary: null, state: null, href: null })
      }
    })
    return rows
  })()

  // LEFT column — the Jobber paper trail: the milestone rail + the
  // invoice detail inset (number/dates + honest deep-link actions).
  const leftCol = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px', minWidth: 0 }}>
      {/* Records — MILESTONE view (✓ done / ring current / hollow
          not-yet); the chronological version is the Timeline tab. */}
      <div>
        <MicroLabel>Records</MicroLabel>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {milestoneRows.map((r, i) => (
            <MilestoneRow key={r.key} kind={r.kind}
              primary={r.primary} secondary={r.secondary} state={r.state} href={r.href}
              Icon={FAMILY_META[r.family].Icon} glyph={FAMILY_META[r.family].glyph}
              last={i === milestoneRows.length - 1}
              connectorDashed={milestoneRows[i + 1]?.kind === 'future'}
            />
          ))}
          {!data && !loadErr && (
            <div style={{ padding: '14px', textAlign: 'center', color: T.ink.quiet, fontSize: '12px' }}>Loading…</div>
          )}
        </div>
      </div>

      {/* Invoice detail inset — number (classic INV- derivation, no DB
          column) + dates. Build 3 verdict (introspected 2026-07-11):
          Jobber's API has NO send-invoice and NO record-payment
          mutation (only markAsSent/close/reopen bookkeeping flips —
          classic's popup buttons were mock-era local fictions). So the
          actions are HONEST DEEP LINKS into the invoice in Jobber —
          never a button pretending at a capability the API lacks. */}
      {children.invoices.length > 0 && (
        <div style={{ background: T.surface.sunken, borderRadius: T.radius.inset, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '7px' }}>
          <MicroLabel>Invoice detail</MicroLabel>
          {children.invoices.map(inv => {
            const url = recordJobberUrl('invoice', inv)
            const unpaid = inv.status !== 'paid'
            return (
              <div key={inv.id} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '12px', color: T.ink.primary, fontVariantNumeric: T.type.tabular, letterSpacing: T.type.trackNum, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {[
                    invoiceNumber(inv),
                    inv.issued_at && `issued ${fmtDate(inv.issued_at)}`,
                    inv.paid_at && `paid ${fmtDate(inv.paid_at)}`,
                  ].filter(Boolean).join(' · ')}
                </p>
                {url && unpaid && (
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <a className="bee-contact-link" href={url} target="_blank" rel="noreferrer" aria-label={`Collect ${invoiceNumber(inv)} in Jobber`}
                      style={{ padding: '5px 12px', borderRadius: T.radius.control, border: T.border.control, background: T.surface.raised, fontSize: '11px', fontWeight: 500, color: T.ink.primary, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                      Collect in Jobber <IconExternalLink size={11} />
                    </a>
                    <a className="bee-contact-link" href={url} target="_blank" rel="noreferrer" aria-label={`Send ${invoiceNumber(inv)} in Jobber`}
                      style={{ padding: '5px 12px', borderRadius: T.radius.control, border: T.border.control, background: T.surface.raised, fontSize: '11px', fontWeight: 500, color: T.ink.primary, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                      Send in Jobber <IconExternalLink size={11} />
                    </a>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )

  // RIGHT column — the working surface: description + deal-scoped
  // activity/composer.
  const rightCol = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px', minWidth: 0 }}>
      {/* Job description — engagements.description via the shared
          EditableDesc idiom (⌘-Enter/blur/✓ saves, Esc/✗ cancels;
          patchEngagement's boolean keeps a failed save open inline). */}
      {eng && data && (
        <div>
          <MicroLabel>Description</MicroLabel>
          <EditableDesc text={eng.description} showEmpty placeholder="Describe the work…"
            onSave={t => patchEngagement({ description: t })} />
        </div>
      )}

      {/* Recent activity — engagement-scoped quick-glance slice +
          composer; the merged past/future stream is the Timeline tab. */}
      <NotesStream label="Recent activity" items={activity} onPost={addEngagementNote} nowMs={nowMs} />
    </div>
  )

  const overview = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      {closeConfirm}
      <div className="bee-card-cols">
        {leftCol}
        {rightCol}
      </div>
    </div>
  )

  // Action bar — PINNED (sticky) to the card bottom, every tab. NO
  // manual stage mover (7/10 decision): Send to Jobber is the forward
  // door for local engagements; Close… (build 2: moved out of the ···
  // menu) opens the SAME shared CloseEngagementConfirm inline on
  // Overview — there is no Jobber auto-Lost, so the manual close path
  // must always exist.
  const actionBar = (
    <div style={{
      position: 'sticky', bottom: 0, zIndex: 5, background: T.surface.raised,
      borderTop: T.border.divider,
      margin: isMobile ? '0 -16px' : '0 -24px',
      padding: isMobile ? '10px 16px calc(10px + env(safe-area-inset-bottom, 0px))' : '12px 24px',
    }}>
      <ActionRow>
        {client?.phone && (
          <a href={`tel:${client.phone}`} style={actionBtn('accent')}>
            <IconPhone size={14} /> Call
          </a>
        )}
        <button style={actionBtn('gray')} disabled={busy} onClick={() => setTouchOpen(v => !v)}>
          Log touchpoint
        </button>
        {canSendToJobber && client && (
          <button style={actionBtn('accent')} disabled={busy} onClick={() => onSendToJobber(client.id, { engagementId })}>
            <IconSend size={14} /> Send to Jobber
          </button>
        )}
        {jobberHref && (
          <a href={jobberHref} target="_blank" rel="noreferrer" style={actionBtn('gray')}>
            <IconExternalLink size={14} /> Open in Jobber
          </a>
        )}
        {eng && !isTerminal(eng.stage) && (
          <button style={actionBtn('gray')} disabled={busy} onClick={() => { setTab('overview'); setCloseOpen(true) }}>
            Close…
          </button>
        )}
      </ActionRow>
      {touchOpen && (
        <div style={{ marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <select value={touchMethod} onChange={e => setTouchMethod(e.target.value)}
            style={{ padding: '8px 10px', border: T.border.control, borderRadius: T.radius.control, fontSize: '12px', fontFamily: 'inherit', background: T.surface.raised }}>
            <option value="call">Call</option>
            <option value="sms">Text</option>
            <option value="email">Email</option>
            <option value="in_person">In person</option>
          </select>
          <input value={touchNote} onChange={e => setTouchNote(e.target.value)} placeholder="Notes (optional)…"
            onKeyDown={e => { if (e.key === 'Enter') logTouchpoint() }}
            style={{ flex: 1, minWidth: '140px', padding: '8px 12px', border: T.border.control, borderRadius: T.radius.control, fontSize: '12px', fontFamily: 'inherit', outline: 'none' }} />
          <button style={{ ...quietBtn(), minHeight: 0 }} disabled={busy} onClick={logTouchpoint}>Log</button>
        </div>
      )}
    </div>
  )

  const filesTab = (
    <div style={{ padding: '18px 12px', border: T.border.dashed, borderRadius: T.radius.inset, textAlign: 'center' }}>
      <p style={{ fontSize: '12px', color: T.ink.quiet, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
        <IconPaperclip size={14} /> No files yet — quotes, photos, and attachments will land here
      </p>
    </div>
  )

  const stageFam = eng ? (CHIP_STYLES[eng.stage] || CHIP_STYLES.gray) : CHIP_STYLES.gray

  // Days in the CURRENT stage — latest stage_change touchpoint among
  // this engagement's children, created_at fallback (the trail is
  // forward-only, never backfilled). Gated on the fetch (seed rows
  // carry no touchpoints — an anchor guessed from created_at alone
  // would flash wrong then correct). Terminal stages show the
  // ClosedSummary's closed date instead — a closed deal isn't "in" a
  // stage anymore.
  const stageDays = data && eng && !isTerminal(eng.stage)
    ? daysInStage(eng, children.touchpoints, nowMs)
    : null

  const drip = data?.drip ?? null

  // Drip pause/resume (build 3) — the lead-scoped routes keep the
  // paused flag and the progress rows in lockstep (13baa26). The banner
  // stays visible either way (paused is still a LIVE drip — only
  // stopped/completed hides it, and those never come back through
  // these buttons).
  const [dripBusy, setDripBusy] = useState(false)
  async function setDripPaused(pause) {
    if (!client) return
    setDripBusy(true)
    try {
      const res = await fetch(`/api/leads/${client.id}/${pause ? 'drip-pause' : 'drip-resume'}`, { method: 'POST' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setData(d => d && d.drip ? { ...d, drip: { ...d.drip, paused: pause } } : d)
      onLeadPatched(client.id, { paused: pause })
      setToast({ kind: 'success', msg: pause ? 'Drip paused' : 'Drip resumed' })
    } catch (e) {
      setToast({ kind: 'error', msg: `Drip ${pause ? 'pause' : 'resume'} failed: ${e.message}` })
    } finally { setDripBusy(false) }
  }

  const body = (
    <div style={{ padding: isMobile ? '0 16px 0' : '0 24px 0', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <style>{`
        .bee-contact-link:hover { text-decoration: underline !important; text-underline-offset: 2px }
        .bee-card-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 22px; align-items: start; }
        @media (max-width: 700px) { .bee-card-cols { grid-template-columns: 1fr; } }
      `}</style>

      {loadErr && (
        <p style={{ fontSize: '12px', color: T.state.danger.fg, background: T.state.danger.soft, padding: '8px 12px', borderRadius: T.radius.control, }}>
          Couldn’t load engagement: {loadErr}
        </p>
      )}

      {/* MASTHEAD (v2) — persistent above the tabs on every tab.
          Line 1: client identity (name = the ONE place it renders +
          location + Repeat chip) with the deal VALUE right-aligned.
          Line 2: View profile · opened · founded by.
          Line 3: the deal — title (v2 renders it again) + stage chip +
          days-in-stage. Line 4: Type (deal-scoped, its one home). */}
      {eng && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <InitialsAvatar name={client?.name || eng.client_name || '?'} bg={stageFam.bg} text={stageFam.text} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h2 style={{ minWidth: 0, fontSize: '19px', fontWeight: 600, color: T.ink.primary, letterSpacing: T.type.trackTitle, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {client?.name || eng.client_name || 'Client'}
                </h2>
                {client?.location_name && (
                  <span style={{ fontSize: '12px', color: T.ink.muted, whiteSpace: 'nowrap', flexShrink: 0 }}>{client.location_name}</span>
                )}
                {(client?.prior_engagements || 0) > 0 && (
                  <span style={{ flexShrink: 0 }}><StatusChip label="Repeat" styleKey="teal" /></span>
                )}
              </div>
              <p style={{ fontSize: '12px', color: T.ink.muted, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {client && (
                  <>
                    <button onClick={() => onOpenClient(client.id)}
                      style={{ border: 'none', background: 'transparent', fontSize: '12px', fontWeight: 500, color: T.accent.fg, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', padding: 0 }}>
                      View profile
                    </button>
                    {' · '}
                  </>
                )}
                opened {formatFullDate(eng.created_at) || '—'} · founded by {eng.founded_by}
              </p>
            </div>
            {dealValue != null && (
              <p style={{ flexShrink: 0, fontSize: '18px', fontWeight: 600, color: T.ink.primary, fontVariantNumeric: T.type.tabular, letterSpacing: T.type.trackNum }}>
                {fmtMoney(dealValue)}
              </p>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            <span style={{ fontSize: '13px', fontWeight: 500, color: T.ink.primary, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {displayTitle(eng)}
            </span>
            <span style={{ flexShrink: 0 }}>
              <StatusChip label={stageDisplayLabel(eng.stage)} styleKey={eng.stage} />
            </span>
            {stageDays != null && (
              <span style={{ fontSize: '11px', color: T.ink.muted, whiteSpace: 'nowrap', flexShrink: 0 }}>
                {stageDays} day{stageDays === 1 ? '' : 's'} in stage
              </span>
            )}
          </div>
          {/* Type — DEAL-scoped (Kevin's person-vs-deal split); its one
              home — the profile never shows it. ENGAGEMENT-level write. */}
          <div>
            <MetaSelect label="Type" value={eng.project_type || null} options={lookupOptions.projectTypes}
              onPick={(v) => patchEngagement({ project_type: v })} />
          </div>
        </div>
      )}

      {/* Closed outcome — reason + note where an open engagement's drip
          banner would sit (shared component; see beta-stage-control's
          write-path source pin). */}
      {eng && <ClosedSummary engagement={eng} />}

      {/* Drip banner — ONLY while the lead's drip is LIVE (or paused);
          stopped/completed/absent renders NOTHING (Kevin's rule: gone
          after Jobber). Display only — the pause control is Build 3. */}
      {eng && !isTerminal(eng.stage) && drip && (
        <div aria-label="Drip banner" style={{ background: T.surface.sunken, borderRadius: T.radius.inset, padding: '9px 12px', display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px', color: T.ink.secondary }}>
          <span style={{ color: T.ink.muted, display: 'inline-flex', flexShrink: 0 }}><IconSend size={13} /></span>
          <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Drip · step {drip.current_step}{drip.total_steps != null ? ` of ${drip.total_steps}` : ''}
            {drip.next_send_at ? ` · next ${fmtShort(drip.next_send_at)}` : ''}
            {drip.paused ? ' · paused' : ''}
          </span>
          <button disabled={dripBusy} onClick={() => setDripPaused(!drip.paused)}
            style={{ flexShrink: 0, padding: '3px 10px', borderRadius: T.radius.control, border: T.border.control, background: T.surface.raised, fontSize: '11px', fontWeight: 500, color: T.ink.primary, cursor: dripBusy ? 'default' : 'pointer', fontFamily: 'inherit' }}>
            {drip.paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      )}

      <CardTabs
        tabs={[
          { key: 'overview', label: 'Overview' },
          { key: 'timeline', label: 'Timeline', count: (children.notes || []).length + (children.touchpoints || []).length },
          { key: 'files', label: 'Files' },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div style={{ paddingBottom: '10px' }}>
        {tab === 'overview' && overview}
        {tab === 'timeline' && client && eng && (
          <Timeline
            leadId={client.id}
            engagementId={engagementId}
            locationUuid={eng.location_uuid}
            setToast={setToast}
            onLeadPatched={onLeadPatched}
          />
        )}
        {tab === 'files' && filesTab}
      </div>

      {actionBar}
    </div>
  )

  return <OverlayShell isMobile={isMobile} onClose={onClose} maxWidth={840}>{body}</OverlayShell>
}
