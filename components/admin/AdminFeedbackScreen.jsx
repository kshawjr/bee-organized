// components/admin/AdminFeedbackScreen.jsx
// ─────────────────────────────────────────────────────────────
// The Feedback triage surface — org-wide list + detail modal. Extracted from
// BeeHub.jsx (issue 128) following the AdminNotificationsScreen precedent:
// token-first, whole-file hex sweep (lib/beta-feedback-triage-ui.test.tsx),
// composing the shared primitives instead of re-rolling them.
//
// THREE mount sites, all in BeeHub.jsx, all rendering THIS component:
//   1. SuperAdminLayout  → Feedback tab   (elevated, org-wide)
//   2. legacy AdminScreen → Feedback tab  (elevated, org-wide)
//   3. franchise owner/manager nav        (server-scoped to their location)
// The franchise mount is distinguished by the onReportFeedback prop — it also
// drops the location filter and the row meta's location segment, because on
// that mount every row IS the caller's own location.
//
// TOKENIZATION NOTE (the move, issue 128). The issue 126 redesign shipped with
// inline literals; this file resolves every color through T / the ui tokens
// instead. Values with an exact token twin (primary ink, the info blue pair,
// the danger red pair) are unchanged; the handful without one (muted grays,
// input hairlines, the dark action fills) snap to their nearest semantic stop
// — same families, AA-compliant, no layout or behavior change.
'use client'

import React, { useState, useEffect, useContext } from 'react'
import { T } from '@/components/hive/shared/tokens'
import { SECTION_COUNT } from '@/components/ui/tokens'
import FilterChips from '@/components/ui/FilterChips'
import BeeLoader from '@/components/hive/shared/BeeLoader'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'
import { IconBug, IconBulb, IconPlus, IconPaperclip } from '@/components/ui/icons'
// The feedback chip anatomy + status vocabulary live in feedbackShared (one
// home for this surface's My-Items cards, the modal, and this screen) — the
// screen composes FeedbackStatusBadge rather than ui/StatusChip because the
// feedback status families are that shared module's contract.
import {
  feedbackTimeAgo, FeedbackAttachmentList, FeedbackStatusBadge,
  FEEDBACK_STATUS_CONF, FEEDBACK_STATUS_PLAIN, FEEDBACK_STATUS_ORDER,
} from '@/components/feedback/feedbackShared'

// Admin triage detail modal — opened by clicking a row in AdminFeedbackScreen.
function AdminFeedbackDetailModal({ item, onClose, onSaved }) {
  const [status, setStatus]   = useState(item.status)
  const [response, setResponse] = useState(item.admin_response || '')
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState(null)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/feedback/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, admin_response: response.trim() || null }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const updated = await res.json()
      onSaved(updated)
    } catch (e) {
      setError('Could not save — please try again.')
    } finally {
      setSaving(false)
    }
  }

  const fieldLabel = { display:'block', fontSize:'12px', fontWeight:700, color:T.ink.primary, marginBottom:'6px' }
  const fieldInput = { width:'100%', padding:'10px 12px', border:T.border.control, borderRadius:'10px', fontSize:'13px', fontFamily:'inherit', color:T.ink.primary, background:T.surface.raised, boxSizing:'border-box' }

  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) onClose() }} style={{ position:'fixed', inset:0, zIndex:10130, display:'flex', alignItems:'center', justifyContent:'center', padding:'16px', background:T.surface.scrim, fontFamily:'"DM Sans",system-ui,sans-serif' }}>
      <div style={{ background:T.surface.raised, borderRadius:T.radius.card, width:'100%', maxWidth:'600px', maxHeight:'85vh', display:'flex', flexDirection:'column', boxShadow:T.shadow.overlay, overflow:'hidden' }}>
        <div style={{ padding:'16px 20px', borderBottom:T.border.divider, display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:'12px', flexShrink:0 }}>
          <h2 style={{ fontSize:'16px', fontFamily:'Georgia,serif', color:T.ink.primary, margin:0, lineHeight:1.35 }}>
            {item.type === 'bug' ? '🐛' : '✨'} {item.title}
          </h2>
          <button onClick={onClose} aria-label="Close" style={{ background:'none', border:'none', color:T.ink.muted, cursor:'pointer', fontSize:'24px', lineHeight:1, padding:0, flexShrink:0 }}>×</button>
        </div>
        <div style={{ padding:'18px 20px', overflowY:'auto', flex:1, display:'flex', flexDirection:'column', gap:'16px' }}>
          {/* Submitter info */}
          <div style={{ fontSize:'12px', color:T.ink.secondary, lineHeight:1.6 }}>
            <div><strong>From:</strong> {item.submitter_name || 'Unknown'}{item.submitter_email ? ` · ${item.submitter_email}` : ''}</div>
            <div><strong>Location:</strong> {item.location_name || '—'}</div>
            <div><strong>Submitted:</strong> {feedbackTimeAgo(item.created_at)}</div>
          </div>
          {/* Description */}
          <div>
            <p style={{ fontSize:'12px', fontWeight:700, color:T.ink.primary, marginBottom:'6px' }}>Description</p>
            <p style={{ fontSize:'13px', color:T.ink.secondary, lineHeight:1.6, whiteSpace:'pre-wrap', wordBreak:'break-word' }}>{item.description}</p>
          </div>
          {/* Attachments */}
          {Array.isArray(item.attachments) && item.attachments.length > 0 && (
            <div>
              <p style={{ fontSize:'12px', fontWeight:700, color:T.ink.primary, marginBottom:'6px' }}>📎 Attachments ({item.attachments.length})</p>
              <FeedbackAttachmentList attachments={item.attachments} thumb={88} />
            </div>
          )}
          {/* Status */}
          <div>
            <label style={fieldLabel}>Status</label>
            <select value={status} onChange={e => setStatus(e.target.value)} style={{ ...fieldInput, cursor:'pointer' }}>
              {FEEDBACK_STATUS_ORDER.map(s => (
                <option key={s} value={s}>{FEEDBACK_STATUS_PLAIN[s] || FEEDBACK_STATUS_CONF[s].label}</option>
              ))}
            </select>
          </div>
          {/* Admin response */}
          <div>
            <label style={fieldLabel}>Response to user</label>
            <textarea value={response} onChange={e => setResponse(e.target.value)} rows={4} placeholder="Optional — shown to the submitter on their item." style={{ ...fieldInput, outline:'none', resize:'vertical', lineHeight:1.5 }} />
          </div>
          {error && <p style={{ fontSize:'12px', color:T.state.danger.strong }}>{error}</p>}
        </div>
        <div style={{ padding:'14px 20px', borderTop:T.border.divider, display:'flex', justifyContent:'flex-end', gap:'10px', flexShrink:0 }}>
          <button onClick={onClose} style={{ padding:'10px 16px', background:'transparent', border:T.border.control, borderRadius:'10px', fontSize:'13px', fontFamily:'inherit', fontWeight:600, color:T.ink.secondary, cursor:'pointer' }}>Close</button>
          <button onClick={save} disabled={saving} style={{ padding:'10px 18px', background:T.accent.fg, border:'none', borderRadius:'10px', fontSize:'13px', fontFamily:'inherit', fontWeight:700, color:T.accent.onFill, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function AdminFeedbackScreen({
  onPendingCountChange = () => {},
  // VIEW-AS DATA SCOPING IS PER-SURFACE: "view as" swaps displayed
  // role/name only — API calls still ride the REAL session, so when a
  // super_admin impersonates an owner this screen's fetch takes the
  // route's elevated branch and returns ORG-WIDE feedback (over-exposes
  // to the impersonator; real owner sessions are hard-scoped server-side
  // and unaffected). The franchise mount passes the impersonated
  // locationId and /api/admin/feedback already honors ?location_id= for
  // elevated callers. Any other view-as screen that reads role-scoped
  // data needs the same explicit-scope treatment — there is no global fix.
  locationId = null,
  // Composer affordance (opens the existing FeedbackModal). Passed by the
  // franchise feedback mount; the elevated admin mounts omit it — triage
  // there stays read-only and submitters use the Ask Bee Hub footer link.
  onReportFeedback = null,
}) {
  const [items, setItems]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)
  const [typeFilter, setTypeFilter]     = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [mineOnly, setMineOnly]         = useState(false)
  const [locFilter, setLocFilter]       = useState('all')
  const [userQuery, setUserQuery]       = useState('')
  const [selected, setSelected] = useState(null)

  // "Just mine" matches the viewer's own submissions by user_id. Deliberately
  // NOT persisted — every filter here resets on navigation (issue 126). A
  // stored filter would strand someone behind a view they set weeks ago and
  // don't remember (the issue 123 trap); a feedback screen that always opens
  // showing everything is the correct default.
  const currentUserCtx = useContext(CurrentUserContext)
  const myId = currentUserCtx?.id || null

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const url = locationId
        ? `/api/admin/feedback?location_id=${encodeURIComponent(locationId)}`
        : '/api/admin/feedback'
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setItems(Array.isArray(data.items) ? data.items : [])
    } catch (e) {
      setError("Couldn't load feedback. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [locationId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    onPendingCountChange(items.filter(i => i.status === 'submitted').length)
  }, [items, onPendingCountChange])

  // Distinct locations present in the data, for the filter dropdown.
  const locOptions = (() => {
    const seen = new Map()
    items.forEach(i => { if (i.location_id) seen.set(i.location_id, i.location_name || i.location_id) })
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  })()

  // Per-axis match predicates. Kept separate so the counts below can be
  // FACETED — each chip's number is exactly what that choice would show given
  // the OTHER active filters, so the count never lies and no one clicks into
  // an empty list (the issue 119 lesson: the count is what stops the blind
  // click). `type`/`status` are single-choice; `mine` and the text search
  // narrow further.
  const matchType   = (i, t) => t === 'all' || i.type === t
  const matchStatus = (i, s) => s === 'all' || i.status === s
  const matchMine   = (i, m) => !m || (!!myId && i.user_id === myId)
  const matchLoc    = (i)    => locFilter === 'all' || i.location_id === locFilter
  const matchQuery  = (i) => {
    const q = userQuery.trim().toLowerCase()
    if (!q) return true
    return `${i.submitter_name || ''} ${i.submitter_email || ''}`.toLowerCase().includes(q)
  }

  const filtered = items.filter(i =>
    matchType(i, typeFilter) && matchStatus(i, statusFilter) &&
    matchMine(i, mineOnly) && matchLoc(i) && matchQuery(i))

  // Faceted counts: hold the other axes at their current selection, vary the
  // one being counted.
  const countType   = t => items.filter(i => matchType(i, t)   && matchStatus(i, statusFilter) && matchMine(i, mineOnly) && matchLoc(i) && matchQuery(i)).length
  const countStatus = s => items.filter(i => matchType(i, typeFilter) && matchStatus(i, s) && matchMine(i, mineOnly) && matchLoc(i) && matchQuery(i)).length
  const countMine   = m => items.filter(i => matchType(i, typeFilter) && matchStatus(i, statusFilter) && matchMine(i, m) && matchLoc(i) && matchQuery(i)).length

  // The franchise (owner/manager) mount is the one that passes the
  // composer callback; the elevated admin mounts never do. The same
  // signal drives the own-location redundancy rule: on the franchise
  // mount every row IS the caller's location, so the location filter and
  // the row meta's location segment drop there and stay on elevated
  // mounts. If an elevated mount ever gains a composer, split this into
  // its own prop instead of widening this one.
  const franchiseMount = !!onReportFeedback

  // Terminal statuses read as closed: rows dim, and the header's "open"
  // count excludes them.
  const isClosedStatus = s => s === 'shipped' || s === 'declined'
  const openCount = items.filter(i => !isClosedStatus(i.status)).length

  // TYPE — a single-choice segmented control (FilterChips: plain text with an
  // underline under the active segment). This is the core issue 126 fix: the
  // old gray-fill pills read as multi-select toggles even though only one is
  // ever active. "feature" shows as "Ideas" — the owner's word, not ours —
  // while the stored value stays 'feature'.
  const typeItems = [
    { key:'all',     label:'Everything', count: countType('all') },
    { key:'bug',     label:'Bugs',       count: countType('bug') },
    { key:'feature', label:'Ideas',      count: countType('feature') },
  ]
  // STATUS — plain-word labels, and only statuses that ACTUALLY EXIST in the
  // data are offered (plus the active one, so it can't vanish under you). That
  // drops 'declined' — unused in prod — instead of hardcoding its removal, and
  // auto-surfaces 'New'/'In progress' the moment real items land there.
  const statusItems = [
    { key:'all', label:'All', count: countStatus('all') },
    ...FEEDBACK_STATUS_ORDER
      .filter(s => countStatus(s) > 0 || statusFilter === s)
      .map(s => ({ key:s, label: FEEDBACK_STATUS_PLAIN[s], count: countStatus(s) })),
  ]
  // "Just mine" — a SEPARATE axis (who submitted it), never mixed into type or
  // status. Shown only when we know who the viewer is (a real session id);
  // view-as / demo paths have no stable own-id so the control hides.
  const mineItems = [
    { key:'everyone', label:'Everyone',  count: countMine(false) },
    { key:'mine',     label:'Just mine', count: countMine(true) },
  ]

  // Quiet input chrome — the interactive-hairline border (T.border.control,
  // the WCAG 1.4.11 stop inputs and quiet buttons share; container hairlines
  // stay on the decorative thin/divider tiers).
  const quietInput = { padding:'7px 10px', border:T.border.control, borderRadius:'8px', fontSize:'12px', fontFamily:'inherit', color:T.ink.primary, background:T.surface.raised, cursor:'pointer' }

  return (
    <div style={{ padding:'14px 1.25rem 1rem', fontFamily:'DM Sans,system-ui,sans-serif' }}>
      {/* Header — light headline + muted count subtitle. The franchise
          composer button rides the header right as a soft-tinted accent
          action (the cardKit actionBtn idiom: soft tint, never a loud
          fill). */}
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:'12px', marginBottom:'14px' }}>
        <div>
          <h2 style={{ fontSize:'19px', fontWeight:500, color:T.ink.primary, margin:0, lineHeight:1.3 }}>Feedback</h2>
          <p style={{ ...SECTION_COUNT, color:T.ink.muted, marginTop:'2px' }}>
            {loading || error ? '—' : `${items.length} item${items.length !== 1 ? 's' : ''} · ${openCount} open`}
          </p>
        </div>
        {onReportFeedback && (
          <button
            onClick={onReportFeedback}
            aria-label="Report a bug or share an idea"
            style={{ display:'inline-flex', alignItems:'center', gap:'6px', height:'36px', padding:'0 14px', borderRadius:'9px', border:'none', background:T.state.info.soft, color:T.state.info.mid, fontSize:'13px', fontWeight:500, fontFamily:'inherit', cursor:'pointer', whiteSpace:'nowrap', flexShrink:0 }}
          >
            <IconPlus size={13} /> Report a bug or share an idea
          </button>
        )}
      </div>

      {/* TYPE — single-choice segmented control (underline-active, not a
          fill). Reads as one-of, which the old pills did not. */}
      <div style={{ marginBottom:'9px' }}>
        <FilterChips items={typeItems} active={typeFilter} onChange={setTypeFilter} wrap />
      </div>
      {/* STATUS — plain words, only the statuses present in the data. */}
      <div style={{ marginBottom:'9px' }}>
        <FilterChips items={statusItems} active={statusFilter} onChange={setStatusFilter} wrap />
      </div>
      {/* "Just mine" (its own axis) + location (elevated only) + name search. */}
      <div style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap:'10px 16px', marginBottom:'14px' }}>
        {myId && (
          <FilterChips
            items={mineItems}
            active={mineOnly ? 'mine' : 'everyone'}
            onChange={k => setMineOnly(k === 'mine')}
          />
        )}
        {!franchiseMount && (
          <select value={locFilter} onChange={e => setLocFilter(e.target.value)} style={quietInput}>
            <option value="all">All locations</option>
            {locOptions.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
        <input value={userQuery} onChange={e => setUserQuery(e.target.value)} placeholder="Search by name or email" style={{ ...quietInput, cursor:'text', flex:'1 1 200px', maxWidth:'320px' }} />
      </div>

      {loading ? (
        <BeeLoader size="screen" label="Gathering the records…" />
      ) : error ? (
        <div style={{ textAlign:'center', padding:'24px 0' }}>
          <p style={{ fontSize:'13px', color:T.state.danger.strong, marginBottom:'10px' }}>{error}</p>
          <button onClick={load} style={{ padding:'8px 16px', background:T.accent.fg, border:'none', borderRadius:'8px', fontSize:'12px', fontFamily:'inherit', fontWeight:600, color:T.accent.onFill, cursor:'pointer' }}>Retry</button>
        </div>
      ) : filtered.length === 0 ? (
        <p style={{ fontSize:'13px', color:T.ink.muted, textAlign:'center', padding:'30px 0' }}>
          {items.length === 0 ? 'No feedback submitted yet.' : 'No feedback matches these filters.'}
        </p>
      ) : (
        /* One rounded container, hairline-divided rows — not per-row boxes. */
        <div style={{ background:T.surface.raised, border:T.border.thin, borderRadius:'12px', overflow:'hidden' }}>
          {filtered.map((it, idx) => {
            const closed = isClosedStatus(it.status)
            const bug = it.type === 'bug'
            return (
              <button
                key={it.id}
                onClick={() => setSelected(it)}
                style={{
                  width:'100%', display:'flex', alignItems:'center', gap:'12px', padding:'11px 14px',
                  border:'none', borderTop: idx === 0 ? 'none' : T.border.divider,
                  background:'transparent', cursor:'pointer', textAlign:'left', fontFamily:'inherit',
                  opacity: closed ? 0.72 : 1,
                }}
              >
                {/* Soft-tinted type tile — bug → red family, feature → accent blue. */}
                <span style={{ width:'28px', height:'28px', borderRadius:'8px', display:'inline-flex', alignItems:'center', justifyContent:'center', flexShrink:0, background: bug ? T.state.danger.soft : T.state.info.soft, color: bug ? T.state.danger.fg : T.state.info.mid }}>
                  {bug ? <IconBug size={15} /> : <IconBulb size={15} />}
                </span>
                <span style={{ flex:1, minWidth:0 }}>
                  <span style={{ display:'flex', alignItems:'center', gap:'7px', minWidth:0 }}>
                    <span style={{ fontSize:'13px', fontWeight:500, color:T.ink.primary, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{it.title}</span>
                    {Array.isArray(it.attachments) && it.attachments.length > 0 && (
                      <span style={{ flexShrink:0, display:'inline-flex', alignItems:'center', gap:'3px', fontSize:'11px', color:T.ink.muted }}>
                        <IconPaperclip size={11} />{it.attachments.length}
                      </span>
                    )}
                  </span>
                  <span style={{ display:'block', fontSize:'11px', color:T.ink.muted, marginTop:'1px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                    {it.submitter_name || 'Unknown'}
                    {!franchiseMount && it.location_name ? ` · ${it.location_name}` : ''}
                    {` · ${feedbackTimeAgo(it.created_at)}`}
                  </span>
                </span>
                <span style={{ flexShrink:0 }}><FeedbackStatusBadge status={it.status} /></span>
              </button>
            )
          })}
        </div>
      )}

      {selected && (
        <AdminFeedbackDetailModal
          item={selected}
          onClose={() => setSelected(null)}
          onSaved={(updated) => {
            setItems(prev => prev.map(i => i.id === updated.id ? { ...i, ...updated } : i))
            setSelected(null)
          }}
        />
      )}
    </div>
  )
}
