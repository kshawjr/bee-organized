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
// Three pieces, one shared state (useJobBees), placed by EngagementPanel:
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
//   BeeSlackButton    "Put this job in Slack": Slack's mark as an icon button,
//                     under the bees faces, and the small confirm it opens.
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
import { T } from './shared/tokens'
import MiniAvatar from './shared/MiniAvatar'
import { FACE_OVERLAP } from './shared/AssigneeCorner'
import BeeSlackStatus from './shared/BeeSlackStatus'
import { MicroLabel, quietBtn } from './shared/cardKit'
import SlackMark from './shared/SlackMark'
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

  // Exactly the conditions it has always had, as a button, a menu item, and
  // now Slack's mark in the corner.
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

// ── "Put this job in Slack": the Slack mark, third in the corner ──
// Slack's own mark as an icon button, DIRECTLY UNDER the bees faces, on the
// same right edge (2026-11-12, Kevin: "a slack emblem outside that does the
// same thing in the same area, and a quick confirmation box"). It was an item
// in the ··· menu for one day.
//
// A THIRD ROW, not a neighbour of the faces: beside them it would widen the
// corner's column, and that column takes its width straight out of the
// client's name, which on a phone has none to give. Under them it is never
// the widest row, so the name keeps every pixel it had.
//
// Shown in exactly the states the menu item was (ctl.showCreate), nothing
// rendered otherwise. Tapping it opens a small box under it, not a modal:
// what it makes, the channel's name, who goes in, Make it / Cancel.
export const SLACK_BTN = 28   // the button; the mark inside is half of it
export const SLACK_MARK = 14  // 7px clear on every side; one pill is 6.6px

// Who Bee Hub already knows Slack will not take: it asked Slack for this
// bee's email before and nobody had it. Never checked = not known = not said.
export const beesSlackDoesNotKnow = (bees) => (bees || []).filter(b => b && b.slack_checked_at && !b.slack_user_id)
const listNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

export function BeeSlackButton({ ctl, clientName = null, projectType = null }) {
  const open = !!ctl?.dialog
  const close = ctl?.closeDialog
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!ctl?.showCreate) return null
  const { bees, creating } = ctl
  const previewName = slackJobChannelName(clientName, projectType)
  const unknown = beesSlackDoesNotKnow(bees)
  const small = { minHeight: 0, padding: '5px 12px', borderRadius: T.radius.pill, fontSize: '12px', fontWeight: 600, fontFamily: 'inherit' }
  return (
    <span data-bee-slack style={{ position: 'relative', display: 'inline-flex', flexShrink: 0, padding: '2px 4px' }}>
      <button type="button" data-bee-make-channel onClick={() => (open ? close() : ctl.openDialog())}
        aria-label={`${PUT_IN_SLACK}: make a Slack channel for this job`}
        aria-haspopup="dialog" aria-expanded={open}
        title={PUT_IN_SLACK}
        style={{
          width: `${SLACK_BTN}px`, height: `${SLACK_BTN}px`, minHeight: 0, padding: 0, boxSizing: 'border-box',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          border: `1px solid ${T.hairline.control}`, borderRadius: T.radius.round,
          background: T.surface.raised, cursor: 'pointer',
        }}>
        <SlackMark size={SLACK_MARK} />
      </button>
      {open && (
        <div data-bee-slack-confirm role="dialog" aria-label={PUT_IN_SLACK} onClick={e => e.stopPropagation()}
          style={{
            position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 10010,
            width: '260px', maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box', textAlign: 'left',
            background: T.surface.raised, border: T.border.thin, borderRadius: T.radius.inset,
            boxShadow: T.shadow.pop, padding: '12px',
          }}>
          <p data-bee-confirm-what style={{ margin: 0, fontSize: '12px', lineHeight: 1.45, color: T.ink.secondary }}>
            Make a public Slack channel for this job?
          </p>
          <p data-bee-confirm-name style={{ margin: '4px 0 0', fontSize: '13px', fontWeight: 600, lineHeight: 1.35, color: T.ink.primary, overflowWrap: 'anywhere' }}>
            #{previewName}
          </p>
          <p data-bee-confirm-who style={{ margin: '6px 0 0', fontSize: '12px', lineHeight: 1.45, color: T.ink.secondary, overflowWrap: 'anywhere' }}>
            {bees.length
              ? `Going in: ${listNames([...bees.map(b => b.name), 'the owner'])}.`
              : 'Going in: the owner. Nobody is on this job’s visits in Jobber yet.'}
          </p>
          {unknown.length > 0 && (
            <p data-bee-confirm-warning role="note" style={{ margin: '8px 0 0', padding: '6px 8px', borderRadius: T.radius.inset, background: T.surface.sunken, fontSize: '12px', fontWeight: 500, lineHeight: 1.45, color: T.ink.primary, overflowWrap: 'anywhere' }}>
              {`Slack had nobody with the email for ${listNames(unknown.map(b => b.name))} when Bee Hub last checked. If that is still so, they will not be added.`}
            </p>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', marginTop: '10px' }}>
            <button type="button" className="bee-small-action" data-bee-confirm-cancel onClick={close} disabled={creating}
              style={{ ...small, border: 'none', background: 'transparent', color: T.ink.muted, cursor: creating ? 'default' : 'pointer' }}>
              Cancel
            </button>
            <button type="button" className="bee-small-action" data-bee-make-channel-confirm onClick={ctl.createChannel} disabled={creating}
              style={{ ...small, border: 'none', background: T.accent.fg, color: T.accent.onFill, cursor: creating ? 'default' : 'pointer', opacity: creating ? 0.6 : 1 }}>
              {creating ? 'Making…' : 'Make it'}
            </button>
          </div>
        </div>
      )}
    </span>
  )
}
