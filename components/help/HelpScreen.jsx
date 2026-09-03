// components/help/HelpScreen.jsx
// ─────────────────────────────────────────────────────────────
// The Help section. Three tabs:
//
//   Help         sections › topics › items, drilled one level at a time so a
//                phone screen only ever shows one list. An item is a title, a
//                one-line lead, EITHER a video OR a screenshot, the steps one
//                per line, and one optional callout for the thing people get
//                wrong. Every level ends in the ask strip.
//
//   My requests  the owner's own feedback items and reply threads, EXACTLY
//                as they work today: the owner/manager "What you've told us"
//                screen for franchise owners and managers, and the composer's
//                My Items list for everyone else. Nothing here is a copy —
//                both are the same components mounted in a tab.
//
//   What's new   the weekly release note (components/help/WhatsNew): the
//                published weeks, newest first, grouped New / Changed /
//                Fixed; for editors the open draft above them, editable
//                inline, with the Slack preview + post. ?tab=new lands here.
//
// AUTHORING is a set of plus buttons, pencils and chevrons that only render
// when `canEdit` is true (super_admin / corporate, and never under view-as).
// The server is the real gate: an owner's GET never contains a draft and
// every write route 403s them — see lib/beta-help-routes.test.ts.
//
// REORDER: up/down chevrons, one place per tap. DELETE: soft — the row is
// stamped, disappears with everything under it, and sits in a "Deleted"
// list at the bottom of the section view for editors, with Restore.
//
// NOTHING IN THIS FILE IS NAMED `top`. It is a browser global (window.top)
// and shadowing it throws before the page runs — it bit the mockup.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { T } from '@/components/hive/shared/tokens'
import BeeLoader from '@/components/hive/shared/BeeLoader'
import useIsMobile from '@/components/hive/shared/useIsMobile'
import { IconPlus, IconPencil, IconChevronRight } from '@/components/ui/icons'
import OwnerFeedbackScreen from '@/components/feedback/OwnerFeedbackScreen'
import { FeedbackItemCard } from '@/components/feedback/feedbackShared'
import HelpEntryForm from '@/components/help/HelpEntryForm'
import WhatsNew from '@/components/help/WhatsNew'
import { helpBreadcrumb } from '@/lib/help-content'

const FONT = '"DM Sans",system-ui,sans-serif'

// ── small shared pieces ───────────────────────────────────────

function DraftChip() {
  return (
    <span style={{ fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: T.radius.pill, background: T.family.amber.bg, color: T.family.amber.text, whiteSpace: 'nowrap' }}>
      Draft
    </span>
  )
}

// A 44px square tap target around a small glyph — the editor controls.
const iconBtn = {
  width: '44px', height: '44px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  background: 'transparent', border: 'none', color: T.ink.muted, cursor: 'pointer', padding: 0, borderRadius: T.radius.control,
}

function EditorControls({ onEdit, onUp, onDown, canUp, canDown, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
      <button type="button" onClick={onUp} disabled={!canUp} aria-label={`Move ${label} up`} style={{ ...iconBtn, opacity: canUp ? 1 : 0.25 }}>▲</button>
      <button type="button" onClick={onDown} disabled={!canDown} aria-label={`Move ${label} down`} style={{ ...iconBtn, opacity: canDown ? 1 : 0.25 }}>▼</button>
      <button type="button" onClick={onEdit} aria-label={`Edit ${label}`} style={iconBtn}><IconPencil size={16} /></button>
    </span>
  )
}

// The dashed "+ Add …" row at the bottom of a list. Editors only.
function AddButton({ label, onClick }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} data-help-add={label}
      style={{ width: '100%', minHeight: '48px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', background: 'transparent', border: T.border.dashed, borderRadius: T.radius.inset, color: T.ink.secondary, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer' }}>
      <IconPlus size={14} /> {label}
    </button>
  )
}

function BackLink({ label, onClick }) {
  return (
    <button type="button" onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: '44px', padding: '0 6px 0 0', background: 'transparent', border: 'none', color: T.accent.fg, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer' }}>
      <span style={{ display: 'inline-block', transform: 'rotate(180deg)' }}><IconChevronRight size={14} /></span> {label}
    </button>
  )
}

// ── the ask strip ─────────────────────────────────────────────
// Ends every level. Three doors — the guided intake's own three — so the
// type is chosen here and the form opens straight on question 1. Carries
// where the owner was: the breadcrumb in words as `about` (stored as an
// "About:" line under the answers, visible to triage today) and the entry
// id in context (for a future resolver).
export function AskStrip({ crumbs, onAsk, stripRef = null }) {
  const where = helpBreadcrumb(crumbs) || 'Help'
  const deepest = [...crumbs].reverse().find(c => c && c.id) || null
  const ask = (type) => onAsk?.({
    type,
    about: where,
    context: { origin: 'help_ask_strip', screen: 'Help', ...(deepest ? { help_entry_id: deepest.id } : {}) },
  })
  return (
    <div ref={stripRef} data-help-ask-strip style={{ marginTop: '28px', background: T.surface.sunken, border: T.border.thin, borderRadius: T.radius.inset, padding: '16px' }}>
      <p style={{ margin: '0 0 10px', fontSize: '14.5px', color: T.ink.secondary, lineHeight: 1.5 }}>
        Still stuck on <b style={{ color: T.ink.primary }}>{where}</b>? A person reads every one and writes back — the reply lands under My requests.
      </p>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <button type="button" onClick={() => ask('bug')} data-help-door="bug" style={{ minHeight: '46px', padding: '10px 14px', background: T.surface.raised, color: T.ink.primary, border: T.border.control, borderRadius: T.radius.inset, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer' }}>
          🐛 Report a bug
        </button>
        <button type="button" onClick={() => ask('question')} data-help-door="question" style={{ minHeight: '46px', padding: '10px 14px', background: T.ink.primary, color: T.ink.inverse, border: 'none', borderRadius: T.radius.inset, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer' }}>
          ❓ Ask a question
        </button>
        <button type="button" onClick={() => ask('feature')} data-help-door="feature" style={{ minHeight: '46px', padding: '10px 14px', background: T.surface.raised, color: T.ink.primary, border: T.border.control, borderRadius: T.radius.inset, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer' }}>
          ✨ Suggest a feature
        </button>
      </div>
    </div>
  )
}

// ── one item, in full ─────────────────────────────────────────
export function HelpItemView({ item }) {
  return (
    <article data-help-item={item.id}>
      <h2 style={{ fontFamily: 'Georgia,serif', fontSize: '22px', fontWeight: 600, color: T.ink.primary, margin: '0 0 4px', lineHeight: 1.25, display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        {item.title}{item.status === 'draft' && <DraftChip />}
      </h2>
      {item.lead && <p style={{ fontSize: '15px', color: T.ink.secondary, margin: '0 0 14px', lineHeight: 1.5 }}>{item.lead}</p>}
      {item.media_kind === 'video' && item.media_url && (
        <video src={item.media_url} controls playsInline preload="metadata" data-help-media="video"
          style={{ width: '100%', borderRadius: T.radius.inset, background: '#000', marginBottom: '14px', display: 'block' }} />
      )}
      {item.media_kind === 'image' && item.media_url && (
        <img src={item.media_url} alt={item.title} data-help-media="image"
          style={{ width: '100%', borderRadius: T.radius.inset, border: T.border.thin, marginBottom: '14px', display: 'block' }} />
      )}
      {item.steps.length > 0 && (
        <ol style={{ margin: '0 0 14px', padding: '0 0 0 22px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {item.steps.map((s, i) => (
            <li key={i} style={{ fontSize: '15px', color: T.ink.primary, lineHeight: 1.5 }}>{s}</li>
          ))}
        </ol>
      )}
      {item.callout && (
        <div style={{ background: T.brand.goldSoft, borderLeft: `3px solid ${T.brand.gold}`, borderRadius: '0 8px 8px 0', padding: '11px 14px' }}>
          <p style={{ margin: 0, fontSize: '14px', color: T.ink.primary, lineHeight: 1.5 }}><b>Watch out:</b> {item.callout}</p>
        </div>
      )}
    </article>
  )
}

// ── My requests, for the roles that have no owner screen ──────
// Lite users and the corp tier see their own items the way the composer's
// My Items tab shows them — same route, same card.
function MyRequestsList({ viewAsUserId }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(viewAsUserId ? `/api/feedback?user_id=${encodeURIComponent(viewAsUserId)}` : '/api/feedback')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setItems(Array.isArray(data.items) ? data.items : [])
    } catch { setError("Couldn't load your items. Please try again.") }
    finally { setLoading(false) }
  }, [viewAsUserId])
  useEffect(() => { load() }, [load])
  if (loading) return <BeeLoader label="Gathering your reports…" />
  if (error) return <p style={{ color: T.state.danger.strong }}>{error}</p>
  if (items.length === 0) return <p style={{ color: T.ink.quiet, fontSize: '14.5px' }}>You haven&rsquo;t sent anything yet. The ask strip under any Help item is the fastest way.</p>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {items.map(it => (
        <FeedbackItemCard key={it.id} item={it} allowReply={!viewAsUserId}
          onReplied={(id, row) => setItems(prev => prev.map(i => i.id === id ? { ...i, replies: [...(Array.isArray(i.replies) ? i.replies : []), row] } : i))} />
      ))}
    </div>
  )
}

// ── the screen ────────────────────────────────────────────────
export default function HelpScreen({
  canEdit = false,
  // Which My requests to mount — the same split the nav makes today.
  role = 'franchise',
  franchiseRole = 'owner',
  locationId = null,
  viewAsUserId = null,
  onAsk = null,             // ({ type, description, context }) → opens the composer
  onReportSomething = null, // the owner screen's own button
  initialTab = null,        // 'help' | 'requests' | 'new' — else read from ?tab=
  // A one-shot instruction from the shell while this screen may already be
  // mounted: 'requests' (the legacy /?feedback=1 deep link) or 'ask' (the
  // Ask Bee Hub footer — land on the ask strip). Consumed once.
  intent = null,
  onIntentConsumed = null,
}) {
  const isMobile = useIsMobile()
  const [tab, setTab] = useState(() => {
    if (initialTab) return initialTab
    try {
      const t = new URLSearchParams(window.location.search).get('tab')
      return t === 'requests' ? 'requests' : t === 'new' ? 'new' : 'help'
    } catch { return 'help' }
  })
  const [sections, setSections] = useState([])
  const [deleted, setDeleted] = useState([])
  const [notSetUp, setNotSetUp] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [view, setView] = useState({ sectionId: null, topicId: null, itemId: null })
  const [form, setForm] = useState(null) // { mode, kind, parentId, entry, breadcrumb }
  const [busy, setBusy] = useState(false)
  const askStripRef = useRef(null)

  useEffect(() => {
    if (!intent) return
    if (intent === 'requests') setTab('requests')
    if (intent === 'ask') {
      setTab('help')
      setView({ sectionId: null, topicId: null, itemId: null })
      // After the list has rendered, bring the strip up under their thumb.
      setTimeout(() => { try { askStripRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch {} }, 60)
    }
    onIntentConsumed?.()
  }, [intent, onIntentConsumed])

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/help/entries')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setSections(Array.isArray(data.sections) ? data.sections : [])
      setDeleted(Array.isArray(data.deleted) ? data.deleted : [])
      setNotSetUp(!!data.notSetUp)
    } catch { setError('Couldn’t load Help. Please try again.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const section = useMemo(() => sections.find(s => s.id === view.sectionId) || null, [sections, view.sectionId])
  const topic = useMemo(() => section?.children.find(t => t.id === view.topicId) || null, [section, view.topicId])
  const item = useMemo(() => topic?.children.find(i => i.id === view.itemId) || null, [topic, view.itemId])
  const crumbs = [section, topic, item].filter(Boolean)

  // If the thing being viewed vanished (deleted, or a draft that got
  // unpublished under view-as), step back up rather than show a blank.
  useEffect(() => {
    if (loading) return
    if (view.itemId && !item) setView(v => ({ ...v, itemId: null }))
    else if (view.topicId && !topic) setView(v => ({ ...v, topicId: null, itemId: null }))
    else if (view.sectionId && !section) setView({ sectionId: null, topicId: null, itemId: null })
  }, [loading, view, section, topic, item])

  async function move(entry, direction) {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetch(`/api/help/entries/${entry.id}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction }) })
      if (!res.ok) throw new Error()
      await load()
    } catch { setError('Couldn’t move that. Please try again.') }
    finally { setBusy(false) }
  }

  async function restore(entry) {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetch(`/api/help/entries/${entry.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restore: true }) })
      if (!res.ok) throw new Error()
      await load()
    } catch { setError('Couldn’t restore that. Please try again.') }
    finally { setBusy(false) }
  }

  const openAdd = (kind, parentId, breadcrumb) => setForm({ mode: 'add', kind, parentId, entry: null, breadcrumb })
  const openEdit = (entry, breadcrumb) => setForm({ mode: 'edit', kind: entry.kind, parentId: entry.parent_id, entry, breadcrumb })

  const countItems = (node) => node.kind === 'item' ? 1 : node.children.reduce((n, c) => n + countItems(c), 0)

  const rowStyle = {
    width: '100%', display: 'flex', alignItems: 'center', gap: '12px', minHeight: '56px', padding: '10px 6px 10px 16px',
    background: T.surface.raised, border: T.border.card, borderRadius: T.radius.inset, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
  }

  // ── the three Help views ──
  const renderSections = () => (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {sections.map((s, i) => (
          <div key={s.id} style={rowStyle} role="button" tabIndex={0} onClick={() => setView({ sectionId: s.id, topicId: null, itemId: null })}
            onKeyDown={e => { if (e.key === 'Enter') setView({ sectionId: s.id, topicId: null, itemId: null }) }} data-help-section={s.id}>
            <span style={{ fontSize: '22px', lineHeight: 1, flexShrink: 0 }}>{s.icon || '📘'}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: '16px', fontWeight: 600, color: T.ink.primary }}>{s.title}</span>
              <span style={{ display: 'block', fontSize: '13px', color: T.ink.quiet }}>{countItems(s)} {countItems(s) === 1 ? 'item' : 'items'}</span>
            </span>
            {canEdit
              ? <EditorControls label={s.title} onEdit={() => openEdit(s, '')} onUp={() => move(s, 'up')} onDown={() => move(s, 'down')} canUp={i > 0} canDown={i < sections.length - 1} />
              : <span style={{ color: T.ink.quiet, paddingRight: '8px' }}><IconChevronRight size={16} /></span>}
          </div>
        ))}
        {sections.length === 0 && !canEdit && (
          <p style={{ color: T.ink.quiet, fontSize: '14.5px', margin: '8px 0' }}>Nothing here yet. Help is being written — check back soon, or ask below.</p>
        )}
        {canEdit && <AddButton label="Add section" onClick={() => openAdd('section', null, '')} />}
      </div>
      {canEdit && deleted.length > 0 && (
        <div style={{ marginTop: '22px' }}>
          <p style={{ fontSize: '12px', fontWeight: 600, letterSpacing: '0.6px', textTransform: 'uppercase', color: T.ink.muted, margin: '0 0 6px' }}>Deleted</p>
          {deleted.map(d => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', minHeight: '44px', fontSize: '14px', color: T.ink.secondary }}>
              <span style={{ flex: 1 }}>{d.title} <span style={{ color: T.ink.quiet }}>· {d.kind}</span></span>
              <button type="button" onClick={() => restore(d)} className="bee-small-action" style={{ minHeight: '36px', padding: '6px 12px', background: T.surface.raised, border: T.border.control, borderRadius: T.radius.control, fontFamily: 'inherit', fontWeight: 600, color: T.ink.primary, cursor: 'pointer' }}>Restore</button>
            </div>
          ))}
        </div>
      )}
      <AskStrip crumbs={[]} onAsk={onAsk} stripRef={askStripRef} />
    </>
  )

  const renderSection = () => (
    <>
      <BackLink label="Help" onClick={() => setView({ sectionId: null, topicId: null, itemId: null })} />
      <h2 style={{ fontFamily: 'Georgia,serif', fontSize: '22px', fontWeight: 600, color: T.ink.primary, margin: '4px 0 14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span>{section.icon || '📘'}</span> {section.title}
      </h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
        {section.children.map((t, ti) => (
          <div key={t.id} data-help-topic={t.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minHeight: '44px' }}>
              <h3 style={{ flex: 1, fontSize: '13px', fontWeight: 600, letterSpacing: '0.6px', textTransform: 'uppercase', color: T.ink.muted, margin: 0 }}>{t.title}</h3>
              {canEdit && <EditorControls label={t.title} onEdit={() => openEdit(t, helpBreadcrumb([section]))} onUp={() => move(t, 'up')} onDown={() => move(t, 'down')} canUp={ti > 0} canDown={ti < section.children.length - 1} />}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {t.children.map((it, ii) => (
                <div key={it.id} style={rowStyle} role="button" tabIndex={0} data-help-item-row={it.id}
                  onClick={() => setView({ sectionId: section.id, topicId: t.id, itemId: it.id })}
                  onKeyDown={e => { if (e.key === 'Enter') setView({ sectionId: section.id, topicId: t.id, itemId: it.id }) }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '15.5px', fontWeight: 600, color: T.ink.primary }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.title}</span>
                      {it.status === 'draft' && <DraftChip />}
                    </span>
                    {it.lead && <span style={{ display: 'block', fontSize: '13.5px', color: T.ink.muted, lineHeight: 1.4 }}>{it.lead}</span>}
                  </span>
                  <span style={{ fontSize: '14px', flexShrink: 0 }}>{it.media_kind === 'video' ? '🎥' : it.media_kind === 'image' ? '🖼️' : ''}</span>
                  {canEdit
                    ? <EditorControls label={it.title} onEdit={() => openEdit(it, helpBreadcrumb([section, t]))} onUp={() => move(it, 'up')} onDown={() => move(it, 'down')} canUp={ii > 0} canDown={ii < t.children.length - 1} />
                    : <span style={{ color: T.ink.quiet, paddingRight: '8px' }}><IconChevronRight size={16} /></span>}
                </div>
              ))}
              {canEdit && <AddButton label="Add item" onClick={() => openAdd('item', t.id, helpBreadcrumb([section, t]))} />}
            </div>
          </div>
        ))}
        {canEdit && <AddButton label="Add topic" onClick={() => openAdd('topic', section.id, helpBreadcrumb([section]))} />}
      </div>
      <AskStrip crumbs={[section]} onAsk={onAsk} />
    </>
  )

  const renderItem = () => (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <BackLink label={section.title} onClick={() => setView(v => ({ ...v, itemId: null }))} />
        {canEdit && (
          <button type="button" onClick={() => openEdit(item, helpBreadcrumb([section, topic]))} aria-label={`Edit ${item.title}`} style={{ ...iconBtn, marginLeft: 'auto' }}><IconPencil size={16} /></button>
        )}
      </div>
      <p style={{ fontSize: '13px', color: T.ink.quiet, margin: '0 0 6px' }}>{helpBreadcrumb([section, topic])}</p>
      <HelpItemView item={item} />
      <AskStrip crumbs={[section, topic, item]} onAsk={onAsk} />
    </>
  )

  const showOwnerScreen = role === 'franchise' && ['owner', 'manager'].includes(franchiseRole)

  return (
    <div style={{ maxWidth: '760px', margin: '0 auto', padding: '22px 16px 70px', fontFamily: FONT }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <h1 style={{ fontFamily: 'Georgia,"Iowan Old Style",serif', fontWeight: 600, fontSize: '26px', lineHeight: 1.2, color: T.ink.primary, margin: 0 }}>Help</h1>
        <div style={{ display: 'flex', gap: '7px' }} role="tablist">
          {[{ key: 'help', label: 'Help' }, { key: 'new', label: 'What’s new' }, { key: 'requests', label: 'My requests' }].map(t => {
            const on = tab === t.key
            return (
              <button key={t.key} type="button" role="tab" aria-selected={on} onClick={() => setTab(t.key)}
                style={{ minHeight: '40px', border: on ? `1px solid ${T.ink.primary}` : T.border.thin, background: on ? T.ink.primary : T.surface.raised, color: on ? T.ink.inverse : T.ink.secondary, borderRadius: T.radius.pill, padding: '7px 15px', fontFamily: 'inherit', cursor: 'pointer' }}>
                {t.label}
              </button>
            )
          })}
        </div>
      </div>

      {tab === 'new' ? (
        <WhatsNew canEdit={canEdit} isMobile={isMobile} />
      ) : tab === 'requests' ? (
        showOwnerScreen
          ? <OwnerFeedbackScreen locationId={locationId} onReportSomething={onReportSomething} title={null} />
          : <MyRequestsList viewAsUserId={viewAsUserId} />
      ) : loading ? (
        <BeeLoader size="screen" label="Opening Help…" />
      ) : error ? (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <p style={{ fontSize: '13px', color: T.state.danger.strong, marginBottom: '10px' }}>{error}</p>
          <button type="button" onClick={load} style={{ padding: '8px 16px', background: T.accent.fg, border: 'none', borderRadius: T.radius.control, fontFamily: 'inherit', fontWeight: 600, color: T.accent.onFill, cursor: 'pointer' }}>Retry</button>
        </div>
      ) : (
        <>
          {notSetUp && canEdit && (
            <p style={{ fontSize: '13.5px', color: T.state.warning.deep, background: T.state.warning.bg, padding: '10px 12px', borderRadius: T.radius.control, marginBottom: '12px' }}>
              Help isn&rsquo;t set up yet — run migrations/help_entries.sql. Owners just see an empty list until then.
            </p>
          )}
          {item ? renderItem() : section ? renderSection() : renderSections()}
        </>
      )}

      {form && (
        <HelpEntryForm
          isMobile={isMobile}
          mode={form.mode} kind={form.kind} parentId={form.parentId} entry={form.entry} breadcrumb={form.breadcrumb}
          onClose={() => setForm(null)}
          onSaved={async () => { setForm(null); await load() }}
        />
      )}
    </div>
  )
}
