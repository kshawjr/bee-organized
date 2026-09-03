// components/help/WhatsNew.jsx
// ─────────────────────────────────────────────────────────────
// The What's new tab: the weekly release note, as owners read it and as
// Kevin edits it.
//
//   OWNERS see the published weeks, newest first, each grouped New /
//   Changed / Fixed — a headline and one sentence per line. The server
//   never sends them the draft, a removed line, or a line still in the
//   owner's words (GET /api/help/releases decides; this file only draws).
//
//   EDITORS (super_admin / corporate, never under view-as) see the open
//   draft above the published weeks. It fills itself: marking a feedback
//   entry Fixed seeds a line here in the owner's own words, greyed and
//   flagged, and a count at the top says how many are waiting. A pencil on
//   every line opens a sheet (ReleaseItemForm) with the original report as
//   reference; a plus row adds something that shipped with no report
//   behind it; the summary line has its own pencil. "Preview the Slack
//   post" opens WagglePreview — the message as it will land, editable, and
//   one button that posts it AND publishes the week to Help.
//
// Everything is phone-first: sheets, 44px targets, 16px inputs.
// NOTHING IN THIS FILE IS NAMED `top` (browser global).
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { T } from '@/components/hive/shared/tokens'
import BeeLoader from '@/components/hive/shared/BeeLoader'
import { IconPlus, IconPencil } from '@/components/ui/icons'
import ReleaseItemForm from '@/components/help/ReleaseItemForm'
import WagglePreview from '@/components/help/WagglePreview'
import { GROUP_ORDER, GROUP_LABEL, GROUP_EMOJI } from '@/lib/help-releases'

const iconBtn = {
  width: '44px', height: '44px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  background: 'transparent', border: 'none', color: T.ink.muted, cursor: 'pointer', padding: 0, borderRadius: T.radius.control, flexShrink: 0,
}
const btnPrimary = {
  minHeight: '46px', padding: '10px 18px', background: T.ink.primary, color: T.ink.inverse,
  border: 'none', borderRadius: T.radius.inset, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer',
}

function Chip({ family = 'amber', children, attr }) {
  return (
    <span {...attr} style={{ fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: T.radius.pill, background: T.family[family].bg, color: T.family[family].text, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  )
}

// ── one line ──────────────────────────────────────────────────
function ReleaseLine({ item, canEdit, onEdit }) {
  const grey = item.unedited
  return (
    <div data-whatsnew-item={item.id} data-whatsnew-unedited={grey ? 'true' : undefined}
      style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '8px 0', opacity: grey ? 0.55 : 1 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '15.5px', fontWeight: 600, color: T.ink.primary, lineHeight: 1.35 }}>{item.title}</span>
          {grey && <Chip attr={{ 'data-whatsnew-flag': item.id }}>Their words</Chip>}
        </div>
        {item.body
          ? <p style={{ margin: '2px 0 0', fontSize: '14.5px', color: T.ink.secondary, lineHeight: 1.5 }}>{item.body}</p>
          : (canEdit && <p style={{ margin: '2px 0 0', fontSize: '13px', color: T.ink.quiet, fontStyle: 'italic' }}>{grey ? 'Rewrite this in your words to include it.' : 'No sentence yet — it stays out of the Slack post.'}</p>)}
      </div>
      {canEdit && (
        <button type="button" onClick={() => onEdit(item)} aria-label={`Edit ${item.title}`} style={iconBtn}><IconPencil size={16} /></button>
      )}
    </div>
  )
}

function Groups({ release, canEdit, onEdit }) {
  const any = GROUP_ORDER.some(g => release.groups[g].length > 0)
  if (!any) return <p style={{ margin: '6px 0 0', fontSize: '14px', color: T.ink.quiet }}>Nothing in this week yet.</p>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {GROUP_ORDER.map(g => release.groups[g].length > 0 && (
        <div key={g} data-whatsnew-group={g}>
          <p style={{ fontSize: '12px', fontWeight: 600, letterSpacing: '0.6px', textTransform: 'uppercase', color: T.ink.muted, margin: '0 0 2px' }}>
            {GROUP_EMOJI[g]} {GROUP_LABEL[g]}
          </p>
          {release.groups[g].map(it => <ReleaseLine key={it.id} item={it} canEdit={canEdit} onEdit={onEdit} />)}
        </div>
      ))}
    </div>
  )
}

// ── a published week ──────────────────────────────────────────
function ReleaseCard({ release, canEdit, onEdit }) {
  return (
    <section data-whatsnew-release={release.id}
      style={{ background: T.surface.raised, border: T.border.card, borderRadius: T.radius.inset, padding: '16px' }}>
      <h2 style={{ fontFamily: 'Georgia,serif', fontSize: '19px', fontWeight: 600, color: T.ink.primary, margin: '0 0 2px' }}>
        Week ending {release.week_label}
      </h2>
      {release.summary && <p style={{ margin: '0 0 10px', fontSize: '14.5px', color: T.ink.secondary, lineHeight: 1.5 }}>{release.summary}</p>}
      {!release.summary && <div style={{ height: '6px' }} />}
      <Groups release={release} canEdit={canEdit} onEdit={onEdit} />
      {canEdit && release.slack_posted_at && (
        <p style={{ margin: '10px 0 0', fontSize: '12.5px', color: T.ink.quiet }}>Posted to Slack.</p>
      )}
      {canEdit && !release.slack_posted_at && release.slack_error && (
        <p style={{ margin: '10px 0 0', fontSize: '12.5px', color: T.state.warning.deep }}>Published to Help. The Slack post didn’t go: {release.slack_error}</p>
      )}
    </section>
  )
}

// ── the open draft (editors) ──────────────────────────────────
function DraftCard({ draft, onEditItem, onAddItem, onEditSummary, onPreview }) {
  const n = draft.unedited_count
  return (
    <section data-whatsnew-draft={draft.id}
      style={{ background: T.surface.raised, border: `1px solid ${T.ink.primary}`, borderRadius: T.radius.inset, padding: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '4px' }}>
        <h2 style={{ fontFamily: 'Georgia,serif', fontSize: '19px', fontWeight: 600, color: T.ink.primary, margin: 0, flex: 1 }}>
          This week · ending {draft.week_label}
        </h2>
        <Chip family="amber">Draft</Chip>
      </div>
      {n > 0 && (
        <p data-whatsnew-unedited-count style={{ margin: '0 0 10px', fontSize: '13.5px', color: T.state.warning.deep, background: T.state.warning.bg, padding: '8px 10px', borderRadius: T.radius.control, lineHeight: 1.45 }}>
          {n === 1 ? '1 line is' : `${n} lines are`} still in the owner’s words. They stay out of Help and out of the Slack post until you rewrite them.
        </p>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minHeight: '44px' }}>
        {draft.summary
          ? <p style={{ flex: 1, margin: 0, fontSize: '14.5px', color: T.ink.secondary, lineHeight: 1.5 }}>{draft.summary}</p>
          : <p style={{ flex: 1, margin: 0, fontSize: '13.5px', color: T.ink.quiet, fontStyle: 'italic' }}>No summary line yet — one sentence on the week (optional).</p>}
        <button type="button" onClick={onEditSummary} aria-label="Edit summary" data-whatsnew-edit-summary style={iconBtn}><IconPencil size={16} /></button>
      </div>
      <Groups release={draft} canEdit onEdit={onEditItem} />
      <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <button type="button" onClick={onAddItem} data-whatsnew-add
          style={{ width: '100%', minHeight: '48px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', background: 'transparent', border: T.border.dashed, borderRadius: T.radius.inset, color: T.ink.secondary, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer' }}>
          <IconPlus size={14} /> Add something that shipped
        </button>
        <button type="button" onClick={onPreview} data-whatsnew-preview style={btnPrimary}>
          Preview the Slack post
        </button>
      </div>
    </section>
  )
}

// ── the tab ───────────────────────────────────────────────────
export default function WhatsNew({ canEdit = false, isMobile = false }) {
  const [data, setData] = useState({ releases: [], draft: null, notSetUp: false })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [sheet, setSheet] = useState(null) // { kind: 'item', mode, item } | { kind: 'summary' } | { kind: 'waggle' }

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/help/releases')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = await res.json()
      setData({ releases: Array.isArray(d.releases) ? d.releases : [], draft: d.draft || null, notSetUp: !!d.notSetUp })
    } catch { setError('Couldn’t load What’s new. Please try again.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  if (loading) return <BeeLoader size="screen" label="Opening What’s new…" />
  if (error) {
    return (
      <div style={{ textAlign: 'center', padding: '24px 0' }}>
        <p style={{ fontSize: '13px', color: T.state.danger.strong, marginBottom: '10px' }}>{error}</p>
        <button type="button" onClick={load} style={{ padding: '8px 16px', background: T.accent.fg, border: 'none', borderRadius: T.radius.control, fontFamily: 'inherit', fontWeight: 600, color: T.accent.onFill, cursor: 'pointer' }}>Retry</button>
      </div>
    )
  }

  const { releases, draft, notSetUp } = data
  const editing = canEdit && !notSetUp

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {notSetUp && canEdit && (
        <p style={{ fontSize: '13.5px', color: T.state.warning.deep, background: T.state.warning.bg, padding: '10px 12px', borderRadius: T.radius.control, margin: 0 }}>
          What’s new isn’t set up yet — run migrations/help_releases.sql. Owners just see an empty tab until then.
        </p>
      )}

      {editing && draft && (
        <DraftCard draft={draft}
          onEditItem={(item) => setSheet({ kind: 'item', mode: 'edit', item })}
          onAddItem={() => setSheet({ kind: 'item', mode: 'add', item: null })}
          onEditSummary={() => setSheet({ kind: 'summary' })}
          onPreview={() => setSheet({ kind: 'waggle' })} />
      )}
      {editing && !draft && (
        <div style={{ background: T.surface.sunken, border: T.border.thin, borderRadius: T.radius.inset, padding: '14px 16px' }}>
          <p style={{ margin: '0 0 10px', fontSize: '14px', color: T.ink.secondary, lineHeight: 1.5 }}>
            Nothing in this week’s draft yet. Marking a report Fixed adds a line here on its own — or add one by hand.
          </p>
          <button type="button" onClick={() => setSheet({ kind: 'item', mode: 'add', item: null })} data-whatsnew-add
            style={{ minHeight: '46px', padding: '10px 14px', display: 'inline-flex', alignItems: 'center', gap: '8px', background: T.surface.raised, border: T.border.control, borderRadius: T.radius.inset, color: T.ink.primary, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer' }}>
            <IconPlus size={14} /> Add something that shipped
          </button>
        </div>
      )}

      {releases.map(r => <ReleaseCard key={r.id} release={r} canEdit={editing} onEdit={(item) => setSheet({ kind: 'item', mode: 'edit', item })} />)}

      {releases.length === 0 && !canEdit && (
        <p style={{ color: T.ink.quiet, fontSize: '14.5px', margin: '8px 0' }}>Nothing here yet. Each week’s changes land here — check back after Thursday.</p>
      )}

      {sheet?.kind === 'item' && (
        <ReleaseItemForm isMobile={isMobile} mode={sheet.mode} item={sheet.item}
          onClose={() => setSheet(null)}
          onSaved={() => { setSheet(null); load() }} />
      )}
      {sheet?.kind === 'summary' && draft && (
        <ReleaseItemForm isMobile={isMobile} mode="summary" release={draft}
          onClose={() => setSheet(null)}
          onSaved={() => { setSheet(null); load() }} />
      )}
      {sheet?.kind === 'waggle' && draft && (
        <WagglePreview isMobile={isMobile} release={draft}
          onClose={() => setSheet(null)}
          onPublished={() => { load() }} />
      )}
    </div>
  )
}
