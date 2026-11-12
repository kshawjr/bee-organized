// components/hive/BeesOnJob.jsx
// ─────────────────────────────────────────────────────────────
// The Bees cell on the engagement panel (Slack job channels, slice 3).
//
// BEES ARE NOT ASSIGNEES (Kevin: "Assignee is different. That's a Jobber
// function."). Assignees are hub users who sync to Jobber crews and live in
// the masthead's top-right AssigneeCorner — faces only, no label, because
// there assignee IS identity. Bees are a roster with no logins who sync to
// Slack. So this cell FOLLOWS the corner's idiom (faces, ghost +, checklist
// popover, immediate write, max 3 faces then +N, unsyncable people marked)
// but does NOT sit with it. It is made unmistakable three ways:
//   · PLACE — the deal meta band, below the masthead's hairline, beside
//     Type: a fact about this job, not about who owns the record.
//   · LABEL — a "Bees" micro-label, the band's own label for every field.
//     The corner stays label-free; it's the only unlabelled face cluster.
//   · SIZE — the 18px inline disc, a step under the corner's 24px.
// Empty reads "Add bees" beside the dashed ghost, as the band's Type reads
// "Add type".
//
// Under the faces, the job's Slack line:
//   · a channel → its #name (archived when the job is closed)
//   · no channel, Slack ready → "Put this job in Slack" — opens the dialog
//     (THE SAME BeePicker, pre-ticked, plus Make the channel). Never auto.
//   · Slack connected without channels:manage → the reconnect line, shown
//     ONLY to someone who can reconnect (the owner or an admin)
//   · not connected → nothing; bees still assign (Part A works everywhere)
// And, when the job reopened and the unattended sweep couldn't bring the
// channel in line (e.g. a bee taken off it whom the workspace won't let apps
// remove), the lines it stored — same wording as the live toggle, under a
// "When this job reopened" lead-in — until the owner taps Got it.
// Before migrations/engagement_bees.sql runs the GET says setUp:false and
// this renders nothing at all — the panel is exactly as it was.
//
// §8.5 props only, no context. Token-pure.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useState } from 'react'
import { T } from './shared/tokens'
import MiniAvatar from './shared/MiniAvatar'
import BeePicker from './shared/BeePicker'
import BeeSlackStatus from './shared/BeeSlackStatus'
import { MicroLabel, quietBtn } from './shared/cardKit'
import { WizardShell, wizAccentBtn, wizQuietBtn } from './shared/CloseWizardKit'
import { slackJobChannelName } from '@/lib/slack-channel-name'

export const MAX_BEE_FACES = 3
export const RECONNECT_LINE = 'Reconnect Slack to turn on channels for your jobs.'

export default function BeesOnJob({
  engagementId,
  locationUuid,
  clientName = null,
  projectType = null,
  readOnly = false,
  isMobile = false,
  setToast = () => {},
}) {
  const [state, setState] = useState(null) // GET body
  const [open, setOpen] = useState(false)
  const [dialog, setDialog] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [creating, setCreating] = useState(false)
  const [sync, setSync] = useState(null)
  const [clearing, setClearing] = useState(false)

  useEffect(() => {
    let dead = false
    setState(null); setSync(null); setOpen(false); setDialog(false)
    fetch(`/api/engagements/${engagementId}/bees`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (!dead) setState(j) })
      .catch(() => { if (!dead) setState(null) })
    return () => { dead = true }
  }, [engagementId])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!state || !state.setUp) return null

  const bees = state.bees || []
  const roster = state.roster || []
  const slack = state.slack || {}
  const assignedIds = bees.map(b => b.id)

  async function toggle(bee, forceAdd = false) {
    if (busyId) return
    const adding = forceAdd || !assignedIds.includes(bee.id)
    setBusyId(bee.id)
    try {
      const res = adding
        ? await fetch(`/api/engagements/${engagementId}/bees`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bee_id: bee.id }),
          })
        : await fetch(`/api/engagements/${engagementId}/bees?bee_id=${encodeURIComponent(bee.id)}`, { method: 'DELETE' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.message || j?.error || `HTTP ${res.status}`)
      setState(s => {
        const next = { ...s, bees: Array.isArray(j.bees) ? j.bees : s.bees }
        if (j.slack_sync?.status === 'channel_gone') next.slack = { ...s.slack, channel: null }
        if (j.slack_sync?.status === 'scope_lost') next.slack = { ...s.slack, canManageChannels: false }
        // The server drops a stored reopen line about a bee the owner just re-ticked.
        const rec = next.slack?.reconcile
        if (rec?.items?.some(p => p.bee_id === bee.id)) {
          const items = rec.items.filter(p => p.bee_id !== bee.id)
          next.slack = { ...next.slack, reconcile: items.length ? { ...rec, items } : null }
        }
        return next
      })
      setSync(j.slack_sync ?? null)
      setToast({ kind: 'success', msg: `${adding ? 'Added' : 'Took off'} ${bee.name}` })
    } catch (e) {
      setSync(null)
      setToast({ kind: 'error', msg: `Bee ${adding ? 'add' : 'remove'} failed: ${e.message}` })
    } finally { setBusyId(null) }
  }

  // A bee typed in from the picker: into the roster, then onto this job.
  async function added(bee) {
    setState(s => ({ ...s, roster: [...(s.roster || []).filter(b => b.id !== bee.id), bee].sort((a, b) => a.name.localeCompare(b.name)) }))
    await toggle(bee, true)
  }

  async function createChannel() {
    if (creating) return
    setCreating(true)
    try {
      const res = await fetch(`/api/engagements/${engagementId}/slack-channel`, { method: 'POST' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.channel) throw new Error(j?.message || `HTTP ${res.status}`)
      setState(s => ({ ...s, bees: Array.isArray(j.bees) ? j.bees : s.bees, slack: { ...s.slack, channel: j.channel } }))
      setSync(Array.isArray(j.problems) && j.problems.length ? j.problems : null)
      setDialog(false)
      setToast({ kind: 'success', msg: j.already ? `This job already has #${j.channel.name}` : `Made #${j.channel.name} in Slack` })
    } catch (e) {
      setToast({ kind: 'error', msg: e.message })
    } finally { setCreating(false) }
  }

  async function clearReconcile() {
    if (clearing) return
    setClearing(true)
    try {
      const res = await fetch(`/api/engagements/${engagementId}/slack-channel`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear_problems: true }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setState(s => ({ ...s, slack: { ...s.slack, reconcile: null } }))
    } catch {
      setToast({ kind: 'error', msg: 'Couldn’t clear that — try again.' })
    } finally { setClearing(false) }
  }

  const reconcile = slack.reconcile?.items?.length ? slack.reconcile.items : null

  const n = bees.length
  const allNames = bees.map(b => b.name).join(', ')
  const size = T.avatar.inline
  const font = T.avatar.inlineFont

  const cluster = n === 0 ? (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
      <span aria-hidden style={{
        width: size, height: size, borderRadius: T.radius.round,
        border: `1px dashed ${T.hairline.control}`, color: T.ink.faint,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: `calc(${size} * 0.6)`, fontWeight: 400, lineHeight: 1, flexShrink: 0,
      }}>+</span>
      <span style={{ fontSize: '13px', fontWeight: 500, color: T.ink.quiet }}>Add bees</span>
    </span>
  ) : (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      {bees.slice(0, MAX_BEE_FACES).map((b, i) => (
        <span key={b.id} data-bee-face style={{ display: 'inline-flex', marginLeft: i ? '-6px' : 0 }}>
          <MiniAvatar id={b.id} name={b.name} title={b.name} size={size} font={font} ring />
        </span>
      ))}
      {n > MAX_BEE_FACES && (
        <span data-bee-more style={{ marginLeft: '4px', fontSize: '11px', color: T.ink.muted, whiteSpace: 'nowrap' }}>+{n - MAX_BEE_FACES}</span>
      )}
    </span>
  )

  const picker = (
    <BeePicker
      roster={roster}
      assignedIds={assignedIds}
      busyId={busyId}
      onToggle={(b) => toggle(b)}
      slackConnected={!!slack.connected}
      canAdd={!!state.canAddBees && !readOnly}
      locationUuid={locationUuid}
      onAdded={added}
    />
  )

  const showCreate = !readOnly && !slack.channel && slack.connected && slack.canManageChannels && slack.channelsSetUp && !slack.closed
  // Only to someone who can act on it (the owner, or an admin): a manager or a
  // read-only user has no Slack settings to go to, and an instruction nobody
  // can follow is noise. The server decides (slack.canReconnect).
  const showReconnect = !readOnly && !!slack.canReconnect && !slack.channel && slack.connected && !slack.canManageChannels
  const previewName = slackJobChannelName(clientName, projectType)

  return (
    <div data-bee-bees style={{ flex: '0 1 auto', minWidth: 0 }}>
      <MicroLabel>Bees</MicroLabel>
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        {readOnly ? (
          <span title={n === 0 ? 'No bees on this job' : allNames} style={{ display: 'inline-flex', alignItems: 'center' }}>{cluster}</span>
        ) : (
          <button type="button" onClick={() => setOpen(v => !v)} data-bee-bees-trigger
            aria-label={n === 0 ? 'Add bees to this job' : `Bees on this job: ${allNames} — edit`}
            aria-haspopup="true" aria-expanded={open}
            title={n === 0 ? 'Add bees' : allNames}
            style={{ display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}>
            {cluster}
          </button>
        )}
        {open && !readOnly && (
          <div onClick={e => e.stopPropagation()} data-bee-bees-popover
            style={{
              position: 'absolute', left: 0, top: 'calc(100% + 6px)', zIndex: 10010,
              width: '250px', maxHeight: '46vh', overflowY: 'auto',
              background: T.surface.raised, border: T.border.thin, borderRadius: T.radius.inset,
              boxShadow: T.shadow.pop, padding: '8px 12px',
            }}>
            {picker}
            <button type="button" onClick={() => setOpen(false)}
              style={{ display: 'block', width: '100%', marginTop: '6px', padding: '6px 8px', border: 'none', borderTop: T.border.thin, background: 'transparent', color: T.ink.muted, fontSize: '12px', fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', textAlign: 'right' }}>
              Done
            </button>
          </div>
        )}
      </span>

      {slack.channel && (
        <p data-bee-channel style={{ marginTop: '6px', fontSize: '12px', color: T.ink.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          title="This job’s Slack channel">
          #{slack.channel.name}{slack.channel.archived ? ' · archived' : ''}
        </p>
      )}
      {showCreate && (
        <button type="button" className="bee-small-action" data-bee-make-channel onClick={() => { setOpen(false); setDialog(true) }}
          style={{ ...quietBtn(T.accent.deep), minHeight: 0, padding: '5px 10px', marginTop: '8px' }}>
          Put this job in Slack
        </button>
      )}
      {showReconnect && (
        <p data-bee-reconnect style={{ marginTop: '6px', fontSize: '12px', color: T.ink.muted, maxWidth: '40ch' }}>
          {RECONNECT_LINE} Settings › Slack.
        </p>
      )}
      <BeeSlackStatus sync={sync} />
      {reconcile && (
        <div data-bee-reconcile style={{ marginTop: '8px' }}>
          <p style={{ margin: 0, fontSize: '12px', fontWeight: 600, color: T.ink.secondary }}>
            When this job reopened, Bee Hub brought its Slack channel back in line with the bees here, except:
          </p>
          <BeeSlackStatus sync={reconcile} />
          {!readOnly && (
            <button type="button" data-bee-reconcile-ok onClick={clearReconcile} disabled={clearing}
              style={{ ...quietBtn(T.ink.muted), minHeight: 0, padding: '4px 10px', marginTop: '6px' }}>
              {clearing ? 'Clearing…' : 'Got it'}
            </button>
          )}
        </div>
      )}

      {dialog && (
        <WizardShell isMobile={isMobile} onClose={() => !creating && setDialog(false)} title="Put this job in Slack" maxWidth={440}
          footer={(
            <>
              <button type="button" onClick={() => setDialog(false)} disabled={creating} style={wizQuietBtn()}>Cancel</button>
              <button type="button" data-bee-make-channel-confirm onClick={createChannel} disabled={creating} style={wizAccentBtn(creating)}>
                {creating ? 'Making…' : 'Make the channel'}
              </button>
            </>
          )}>
          <p style={{ fontSize: '13px', color: T.ink.secondary, lineHeight: 1.5 }}>
            A public channel called <strong style={{ color: T.ink.primary }}>#{previewName}</strong> (or close to it, if Slack already has one), with the bees you tick below. The location owner is added too, as long as Slack knows the email they use for Bee Hub. Changing bees here later changes the channel straight away.
          </p>
          {picker}
        </WizardShell>
      )}
    </div>
  )
}
