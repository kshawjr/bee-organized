// components/hive/BeesOnJob.jsx
// ─────────────────────────────────────────────────────────────
// The bees on a job, on the engagement panel — a MIRROR (2026-11-12).
//
// Jobber owns who is on a job: an owner puts people on the job's visits
// there, and lib/jobber-crew-mirror.ts makes the job's bees and its Slack
// channel match. So nothing here changes who is on a job. There is no picker,
// no tick and no write of a bee — on purpose: a tick in Bee Hub would either
// do nothing, or fight Jobber, or have to write visits back to Jobber, which
// is the leg that was deleted. Typing a bee by hand lives in Settings › Team
// and Seats.
//
// Four pieces, one shared state (useJobBees), placed by EngagementPanel:
//
//   BeeCorner         the faces, DIRECTLY UNDER the assignee corner in the
//                     masthead's top-right, wearing ITS treatment
//                     (AssigneeCorner.jsx): MiniAvatar at T.avatar.corner,
//                     ringed, overlapped, at most three then +N, a dashed
//                     ghost when empty. One thing differs, so two unlabelled
//                     face clusters are not stacked: a quiet "Bees" label to
//                     the left (dropped on a phone when there are faces —
//                     it was costing the client's name). Clicking it opens a
//                     small card, headed "Bees on this job", that names
//                     everyone (a hover title does not exist on a phone) and
//                     says, in one line, that the crew comes from Jobber.
//   BeeSlackLines     under the identity row: the job's #channel, the
//                     reconnect line, what Slack refused, and the "when this
//                     job reopened" box. Silent when there is nothing to say,
//                     and never a word about Slack where there is no Slack.
//   beeChannelMenuItem  "Put this job in Slack", for the masthead's ··· menu
//                     (RecordMenu drops a falsy item, so "hidden" is exactly
//                     what it was as a button: no item at all).
//   BeeChannelDialog  the confirm it opens.
//
// WHEN THE ROW SHOWS AT ALL: when the job has bees, or the location's Slack
// is reconnected for job channels (the only locations the mirror runs for).
// Anywhere else an empty row would be a ghost nobody can ever fill.
//
// Before migrations/engagement_bees.sql runs the GET says setUp:false and
// every piece renders nothing — the panel is exactly as it was.
//
// §8.5 props only, no context. Token-pure.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useState } from 'react'
import { IconSend } from '@/components/ui/icons'
import { T } from './shared/tokens'
import MiniAvatar from './shared/MiniAvatar'
import { FACE_OVERLAP } from './shared/AssigneeCorner'
import BeeSlackStatus from './shared/BeeSlackStatus'
import { MicroLabel, quietBtn } from './shared/cardKit'
import { WizardShell, wizAccentBtn, wizQuietBtn } from './shared/CloseWizardKit'
import { slackJobChannelName } from '@/lib/slack-channel-name'

export const MAX_BEE_FACES = 3 // the assignee corner's own limit
export const RECONNECT_LINE = 'Reconnect Slack to turn on channels for your jobs.'
// The one line an owner who clicks expecting a picker reads.
export const BEES_FROM_JOBBER = 'Bees come from Jobber: whoever is on this job’s visits. Change it there.'
export const NO_BEES_YET = 'Nobody is on this job’s visits in Jobber yet.'
export const PUT_IN_SLACK = 'Put this job in Slack'

// ── The shared state ─────────────────────────────────────────
// One GET per open job. Returns a controller the four pieces read; every
// field is safe to read before the answer arrives (ready:false).
export function useJobBees(engagementId, { readOnly = false, setToast = () => {} } = {}) {
  const [state, setState] = useState(null) // GET body
  const [dialog, setDialog] = useState(false)
  const [creating, setCreating] = useState(false)
  const [sync, setSync] = useState(null)
  const [clearing, setClearing] = useState(false)

  useEffect(() => {
    let dead = false
    setState(null); setSync(null); setDialog(false)
    if (!engagementId) return undefined
    fetch(`/api/engagements/${engagementId}/bees`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (!dead) setState(j) })
      .catch(() => { if (!dead) setState(null) })
    return () => { dead = true }
  }, [engagementId])

  const ready = !!state && !!state.setUp
  const bees = ready ? state.bees || [] : []
  const slack = ready ? state.slack || {} : {}

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

  // Exactly the conditions the button had (it was a button until 2026-11-12).
  const showCreate = ready && !readOnly && !slack.channel && !!slack.connected && !!slack.canManageChannels && !!slack.channelsSetUp && !slack.closed
  // Only to someone who can act on it (the owner, or an admin): a manager or a
  // read-only user has no Slack settings to go to, and an instruction nobody
  // can follow is noise. The server decides (slack.canReconnect).
  const showReconnect = ready && !readOnly && !!slack.canReconnect && !slack.channel && !!slack.connected && !slack.canManageChannels
  // Bees to show, or a location the mirror actually fills.
  const showRow = ready && (bees.length > 0 || (!!slack.connected && !!slack.canManageChannels))

  return {
    ready, readOnly, bees, slack, sync,
    reconcile: slack.reconcile?.items?.length ? slack.reconcile.items : null,
    showRow, showCreate, showReconnect,
    dialog, openDialog: () => setDialog(true), closeDialog: () => { if (!creating) setDialog(false) },
    creating, createChannel, clearing, clearReconcile,
  }
}

// ── The faces, under the assignee corner ─────────────────────
export function BeeCorner({ ctl, isMobile = false, size = T.avatar.corner, font = T.avatar.cornerFont }) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!ctl?.showRow) return null
  const bees = ctl.bees
  const n = bees.length
  const allNames = bees.map(b => b.name).join(', ')

  // The corner's own cluster, mark for mark (AssigneeCorner.jsx). The ghost
  // carries no "+": nothing is added here.
  const cluster = n === 0 ? (
    <span aria-hidden data-bee-ghost style={{
      width: size, height: size, borderRadius: T.radius.round,
      border: `1px dashed ${T.hairline.control}`, flexShrink: 0, display: 'inline-flex',
    }} />
  ) : (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      {bees.slice(0, MAX_BEE_FACES).map((b, i) => (
        <span key={b.id} data-bee-face style={{ display: 'inline-flex', marginLeft: i ? FACE_OVERLAP : 0 }}>
          <MiniAvatar id={b.id} name={b.name} title={b.name} size={size} font={font} ring />
        </span>
      ))}
      {n > MAX_BEE_FACES && (
        <span data-bee-more style={{ marginLeft: '4px', fontSize: '11px', color: T.ink.muted, whiteSpace: 'nowrap' }}>+{n - MAX_BEE_FACES}</span>
      )}
    </span>
  )

  return (
    <span data-bee-bees style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
      <button type="button" data-bee-bees-trigger onClick={() => setOpen(v => !v)}
        aria-label={n === 0 ? 'Bees on this job: nobody yet' : `Bees on this job: ${allNames}`}
        aria-haspopup="true" aria-expanded={open}
        title={n === 0 ? 'No bees on this job' : allNames}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '6px', border: 'none', background: 'transparent',
          padding: '4px', borderRadius: T.radius.pill, cursor: 'pointer', fontFamily: 'inherit',
        }}>
        {/* The label costs about 35px of the client's name. On a phone the
            name was being cut to "Sarah …" for it, so there the faces go
            unlabelled, exactly like the assignee row above, and the card they
            open carries the heading. An EMPTY ring keeps its label at every
            width: a bare dashed circle says nothing. */}
        {(!isMobile || n === 0) && (
          <span data-bee-label style={{ fontSize: '11px', fontWeight: 500, color: T.ink.muted, lineHeight: 1 }}>Bees</span>
        )}
        {cluster}
      </button>
      {open && (
        <div data-bee-bees-popover role="dialog" aria-label="Bees on this job" onClick={e => e.stopPropagation()}
          style={{
            position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 10010,
            width: '250px', maxWidth: 'calc(100vw - 32px)', maxHeight: '46vh', overflowY: 'auto',
            background: T.surface.raised, border: T.border.thin, borderRadius: T.radius.inset,
            boxShadow: T.shadow.pop, padding: '10px 12px 8px',
          }}>
          <MicroLabel>Bees on this job</MicroLabel>
          {n === 0 ? (
            <p data-bee-none style={{ margin: 0, fontSize: '12px', fontWeight: 500, color: T.ink.secondary }}>{NO_BEES_YET}</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '7px' }}>
              {bees.map(b => (
                <li key={b.id} data-bee-name style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                  <MiniAvatar id={b.id} name={b.name} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: '12px', fontWeight: 500, color: T.ink.primary, overflowWrap: 'anywhere' }}>{b.name}</span>
                </li>
              ))}
            </ul>
          )}
          <p data-bee-from-jobber style={{ margin: '9px 0 0', paddingTop: '8px', borderTop: T.border.thin, fontSize: '12px', lineHeight: 1.45, color: T.ink.muted }}>
            {BEES_FROM_JOBBER}
          </p>
          {/* bee-small-action: without it the app-wide 16px button floor makes
              "Done" bigger than the card's own text (seen in a browser). */}
          <button type="button" className="bee-small-action" data-bee-card-done onClick={() => setOpen(false)}
            style={{ display: 'block', width: '100%', marginTop: '4px', padding: '6px 0 2px', border: 'none', background: 'transparent', color: T.ink.muted, fontSize: '12px', fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', textAlign: 'right' }}>
            Done
          </button>
        </div>
      )}
    </span>
  )
}

// ── The Slack lines, under the identity row ──────────────────
export function BeeSlackLines({ ctl }) {
  if (!ctl?.ready) return null
  const { slack, sync, reconcile, showReconnect, readOnly, clearing, clearReconcile } = ctl
  if (!slack.channel && !showReconnect && !sync && !reconcile) return null
  return (
    <div data-bee-slack-lines style={{ minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
      {slack.channel && (
        <p data-bee-channel title="This job’s Slack channel"
          style={{ margin: 0, maxWidth: '100%', fontSize: '12px', color: T.ink.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          Slack channel <span style={{ color: T.ink.secondary, fontWeight: 500 }}>#{slack.channel.name}</span>{slack.channel.archived ? ' · archived' : ''}
        </p>
      )}
      {showReconnect && (
        <p data-bee-reconnect style={{ margin: 0, fontSize: '12px', color: T.ink.muted, maxWidth: '52ch' }}>
          {RECONNECT_LINE} <span style={{ whiteSpace: 'nowrap' }}>Settings › Slack.</span>
        </p>
      )}
      <BeeSlackStatus sync={sync} />
      {reconcile && (
        <div data-bee-reconcile style={{ marginTop: '8px' }}>
          <p style={{ margin: 0, maxWidth: '52ch', fontSize: '12px', fontWeight: 600, lineHeight: 1.4, color: T.ink.secondary }}>
            When this job reopened, Bee Hub brought its Slack channel back in line with the bees here, except:
          </p>
          <BeeSlackStatus sync={reconcile} />
          {!readOnly && (
            <button type="button" className="bee-small-action" data-bee-reconcile-ok onClick={clearReconcile} disabled={clearing}
              style={{ ...quietBtn(T.ink.muted), minHeight: 0, padding: '4px 10px', marginTop: '6px' }}>
              {clearing ? 'Clearing…' : 'Got it'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── "Put this job in Slack", for the ··· menu ────────────────
// null when it must not be offered; RecordMenu drops a falsy item.
export function beeChannelMenuItem(ctl) {
  if (!ctl?.showCreate) return null
  return { key: 'bee-slack-channel', label: PUT_IN_SLACK, icon: <IconSend size={15} />, onClick: ctl.openDialog }
}

export function BeeChannelDialog({ ctl, clientName = null, projectType = null, isMobile = false }) {
  if (!ctl?.dialog) return null
  const { bees, creating } = ctl
  const previewName = slackJobChannelName(clientName, projectType)
  return (
    <WizardShell isMobile={isMobile} onClose={ctl.closeDialog} title={PUT_IN_SLACK} maxWidth={440}
      footer={(
        <>
          <button type="button" onClick={ctl.closeDialog} disabled={creating} style={wizQuietBtn()}>Cancel</button>
          <button type="button" data-bee-make-channel-confirm onClick={ctl.createChannel} disabled={creating} style={wizAccentBtn(creating)}>
            {creating ? 'Making…' : 'Make the channel'}
          </button>
        </>
      )}>
      <p style={{ fontSize: '13px', color: T.ink.secondary, lineHeight: 1.5 }}>
        A public channel called <strong style={{ color: T.ink.primary }}>#{previewName}</strong> (or close to it, if Slack already has one). The bees on this job are added, and the location owner too, as long as Slack knows the email they use for Bee Hub.
      </p>
      <p data-bee-dialog-who style={{ marginTop: '10px', fontSize: '13px', color: T.ink.secondary, lineHeight: 1.5 }}>
        {bees.length
          ? <>On this job now: <strong style={{ color: T.ink.primary, fontWeight: 600 }}>{bees.map(b => b.name).join(', ')}</strong>.</>
          : <>{NO_BEES_YET} The channel is made now and they are added when they are.</>}
      </p>
      <p style={{ marginTop: '10px', fontSize: '12px', color: T.ink.muted, lineHeight: 1.5 }}>
        When the people on this job’s visits change in Jobber, the channel follows.
      </p>
    </WizardShell>
  )
}
