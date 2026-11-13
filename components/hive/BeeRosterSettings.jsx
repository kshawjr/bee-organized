// components/hive/BeeRosterSettings.jsx
// ─────────────────────────────────────────────────────────────
// The Bees card of Settings › Team — the people who work a
// location's jobs, by name and email. A ROSTER, not logins: nobody here signs
// in to Bee Hub and nobody is billed. It sits BELOW Seats on that screen and
// says so in its first line, because that difference is the whole point of
// having two lists.
//   · Add — "Add a bee" opens a labelled form. The same email twice at one
//     location is refused.
//   · Edit — fix a name or an email (a new email is checked against Slack).
//   · Remove — hides them; nothing is deleted. Bring back restores the same
//     bee, Slack id and all. Removed bees sit behind a disclosure.
//   · Slack — when the location's Slack is connected, each bee carries ONE
//     chip: In your Slack / Not in Slack / Not checked. The explanation
//     appears once, under the row that needs it, with its Check button
//     beside it. Checked on add, on a new email, and on that button — never
//     just by opening this screen. No Slack connected → not a word about
//     Slack, anywhere.
//
// REBUILT TO THE NEW LOOK in Settings slice 2 (2026-11-13, the export's Team
// page): the card, buttons and chips are the Settings shell's
// (components/settings/SettingsShell.jsx) and the colours are the shared
// design tokens. What it does is unchanged. Seven faults on the old layout
// are closed here, each marked FAULT below.
// §8.5: props only; owns its own fetches.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useState } from 'react'
import { T, R, FONT } from '@/components/design/tokens'
import {
  Section, Pill, Btn, IconBtn, Avatar, Notice, Field, initialsOf,
  IconPlus, IconPencil, IconTrash,
} from '@/components/settings/SettingsShell'

// ── What a bee's Slack state reads as ─────────────────────────
// chip: the short state on the row. text: the one explanation under the row
// (null when there is nothing to explain). action: its button's label.
export function beeSlackLine(bee) {
  if (bee.slack_user_id) return { kind: 'found', chip: 'In your Slack', text: null, action: null }
  if (bee.slack_checked_at) return {
    kind: 'not_found',
    chip: 'Not in Slack',
    text: 'That email isn’t in your Slack. Use the one they sign in to Slack with.',
    action: 'Check again',
  }
  return { kind: 'unchecked', chip: 'Not checked', text: 'Not checked against your Slack yet.', action: 'Check now' }
}

// FAULT (the two buttons disagreed): this line used to say "tap Check again"
// whatever the bee's own button read — and a bee Slack could not be reached
// for is "Not checked", whose button says "Check now". The line now names the
// button that bee is actually showing.
export const slackUnreachableNote = (bee) =>
  `Saved. We couldn’t reach Slack to check this email — tap ${beeSlackLine(bee || {}).action || 'Check again'} in a minute.`

export const beeInitials = initialsOf

const CHIP_TONE = { found: 'ok', not_found: 'warn', unchecked: 'quiet' }

const nameStyle = { display: 'block', fontSize: '14px', lineHeight: '20px', fontWeight: 700, color: T.foreground, overflowWrap: 'anywhere' }
// FAULT (long emails cut on a phone): an address WRAPS. It used to be one
// line ending in "…", which on a phone hid the part after the @.
const emailStyle = { display: 'block', fontSize: '12px', lineHeight: '18px', color: T.mutedFg, overflowWrap: 'anywhere' }
const quietLine = { fontSize: '13px', lineHeight: '18px', color: T.mutedFg }

export default function BeeRosterSettings({ locationId = null, locationName = '' }) {
  const [bees, setBees] = useState(null)     // null = loading
  const [loadFailed, setLoadFailed] = useState(false)
  const [slackConnected, setSlackConnected] = useState(false)
  const [serverName, setServerName] = useState('')   // the location's name, as the server knows it
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)      // a calm line (Slack unreachable)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ name: '', email: '' })
  const [editing, setEditing] = useState(null) // { id, name, email }
  const [confirming, setConfirming] = useState(null)
  const [busy, setBusy] = useState(null)

  async function load() {
    if (!locationId) { setBees([]); return }
    setLoadFailed(false)
    try {
      const res = await fetch(`/api/locations/${encodeURIComponent(locationId)}/bees`)
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.message || j?.error || `HTTP ${res.status}`)
      setBees(j.bees || [])
      setSlackConnected(j.slackConnected === true)
      setServerName(typeof j.locationName === 'string' ? j.locationName : '')
    } catch {
      // FAULT (the load failure said the wrong thing): this used to print the
      // raw reason ("HTTP 500") and then, under it, "No bees on your list
      // yet." — which is not known. It now says the list could not be loaded,
      // offers Try again, and says nothing about how many bees there are.
      setLoadFailed(true); setBees([])
    }
  }
  useEffect(() => { load() }, [locationId]) // eslint-disable-line react-hooks/exhaustive-deps

  function take(j) {
    if (typeof j?.slackConnected === 'boolean') setSlackConnected(j.slackConnected)
    setNote(j?.slackCheck === 'unavailable' ? slackUnreachableNote(j.bee) : null)
    const b = j.bee
    setBees(prev => {
      const list = prev || []
      return list.some(x => x.id === b.id) ? list.map(x => (x.id === b.id ? b : x)) : [...list, b]
    })
  }

  async function send(url, method, body, key) {
    setBusy(key); setError(null); setNote(null)
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setError(j?.message || `Couldn't save (${j?.error || res.status}).`); return false }
      take(j)
      return true
    } catch (e) {
      setError(`Couldn't save: ${e.message}`); return false
    } finally { setBusy(null) }
  }

  const base = `/api/locations/${encodeURIComponent(locationId || '')}/bees`
  const add = async () => {
    if (await send(base, 'POST', { name: draft.name, email: draft.email }, 'add')) {
      setDraft({ name: '', email: '' }); setAdding(false)
    }
  }
  const patch = (bee, body) => send(`${base}/${bee.id}`, 'PATCH', body, bee.id)

  const all = (bees || []).slice().sort((a, b) => a.name.localeCompare(b.name))
  const active = all.filter(b => b.is_active !== false)
  const removed = all.filter(b => b.is_active === false)
  const emailLabel = slackConnected ? 'Email they use for Slack' : 'Email'
  const draftReady = draft.name.trim() && draft.email.trim()

  const activeRow = (b) => {
    const slack = slackConnected ? beeSlackLine(b) : null
    const isEditing = editing?.id === b.id
    const isConfirming = confirming?.id === b.id
    return (
      <div key={b.id} data-bee={b.id} style={{ padding: '12px 0', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {isEditing ? (
          <form data-bee-edit onSubmit={async e => { e.preventDefault(); if (await patch(b, { name: editing.name, email: editing.email })) setEditing(null) }}
            style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div data-sfields>
              <Field label="Name" aria-label={`Name for ${b.name}`} value={editing.name}
                onChange={e => setEditing({ ...editing, name: e.target.value })} />
              <Field label={emailLabel} aria-label={`Email for ${b.name}`} type="email" value={editing.email}
                onChange={e => setEditing({ ...editing, email: e.target.value })} />
            </div>
            <div data-sactions>
              <Btn variant="primary" type="submit" disabled={busy === b.id}>Save</Btn>
              <Btn onClick={() => setEditing(null)}>Cancel</Btn>
            </div>
          </form>
        ) : (
          // FAULT (icons dropped to their own line on a phone): a grid, not a
          // wrapping row — the face, the words, the pencil and the bin are
          // four fixed columns at every width; only the words give.
          <div data-bee-row style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr) auto auto', alignItems: 'center', gap: '8px' }}>
            <Avatar name={b.name} />
            <span style={{ minWidth: 0 }}>
              <span data-bee-name style={nameStyle}>{b.name}</span>
              <span data-bee-email style={emailStyle}>{b.email}</span>
            </span>
            <IconBtn label={`Edit ${b.name}`} title="Edit" disabled={!!busy}
              onClick={() => { setError(null); setConfirming(null); setEditing({ id: b.id, name: b.name, email: b.email }) }}>
              <IconPencil size={16} />
            </IconBtn>
            <IconBtn danger label={`Remove ${b.name}`} title="Remove" disabled={!!busy}
              onClick={() => { setError(null); setConfirming(b) }}>
              <IconTrash size={16} />
            </IconBtn>
          </div>
        )}

        {!isEditing && slack && (
          <div><Pill tone={CHIP_TONE[slack.kind]} data-bee-slack={slack.kind}>{slack.chip}</Pill></div>
        )}

        {!isEditing && slack?.text && !isConfirming && (
          <Notice tone={slack.kind === 'not_found' ? 'warn' : 'quiet'} data-bee-slack-note={slack.kind}
            actions={<Btn data-bee-recheck disabled={!!busy} onClick={() => patch(b, { recheck: true })}>{busy === b.id ? 'Checking…' : slack.action}</Btn>}>
            {slack.text}
          </Notice>
        )}

        {isConfirming && (
          <div role="dialog" aria-label={`Remove ${b.name}`}>
            <Notice tone="quiet" actions={<>
              <Btn variant="danger" disabled={busy === b.id}
                onClick={async () => { if (await patch(b, { active: false })) setConfirming(null) }}>Remove</Btn>
              <Btn onClick={() => setConfirming(null)}>Keep them</Btn>
            </>}>
              <span style={{ color: T.foreground }}>Remove {b.name} from your bees? You can bring them back any time, exactly as they were.</span>
            </Notice>
          </div>
        )}
      </div>
    )
  }

  const title = (locationName || serverName) ? `${locationName || serverName}’s bees` : 'Bees'
  return (
    <Section data-settings-ui data-testid="bee-roster-settings" data-team-bees aria-labelledby="team-bees-title" titleId="team-bees-title"
      eyebrow="Bees"
      /* Named for the location: an admin looking at one location's settings
         must be able to tell whose bees these are. */
      title={title}
      intro={<span data-bee-intro>
        The people who work your jobs. <strong style={{ fontWeight: 700, color: T.foreground }}>Not seats</strong> — nobody here signs in to Bee Hub and nobody is billed.
        {slackConnected ? ' Use the email each bee signs in to Slack with, so you can add them to a job’s Slack channel.' : ''}
      </span>}
      /* FAULT ("Add a bee" stayed lit above the open form): the button is
         not drawn while its form is open. The form has its own Cancel. */
      right={adding ? null : (
        <Btn variant="primary" data-bee-add-open icon={<IconPlus size={16} />} aria-expanded={false}
          onClick={() => { setError(null); setAdding(true) }}>Add a bee</Btn>
      )}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', fontFamily: FONT.ui }}>
        {loadFailed && (
          <Notice tone="danger" role="alert" data-bee-load-failed
            actions={<Btn data-bee-retry onClick={() => { setBees(null); load() }}>Try again</Btn>}>
            We couldn’t load your bees just now. Nothing has been changed.
          </Notice>
        )}
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
        {note && <Notice tone="warn" data-bee-note>{note}</Notice>}

        {adding && (
          <form data-bee-add onSubmit={e => { e.preventDefault(); if (draftReady) add() }}
            style={{ borderRadius: R.xl, background: T.muted, padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div data-sfields>
              <Field label="Name" aria-label="Bee name" autoFocus value={draft.name}
                onChange={e => setDraft({ ...draft, name: e.target.value })} />
              <Field label={emailLabel} aria-label="Bee email" type="email" value={draft.email}
                onChange={e => setDraft({ ...draft, email: e.target.value })} />
            </div>
            <div data-sactions>
              <Btn variant="primary" type="submit" disabled={busy === 'add' || !draftReady}>
                {busy === 'add' ? 'Adding…' : 'Add bee'}
              </Btn>
              <Btn onClick={() => { setAdding(false); setDraft({ name: '', email: '' }); setError(null) }}>Cancel</Btn>
            </div>
          </form>
        )}

        {bees == null && <p style={quietLine}>Loading…</p>}
        {bees != null && !loadFailed && active.length === 0 && (
          <p data-bee-empty style={quietLine}>
            {removed.length ? 'No bees on your list right now.' : 'No bees on your list yet.'}
          </p>
        )}
        {active.length > 0 && <div data-slist data-bee-list>{active.map(activeRow)}</div>}

        {removed.length > 0 && (
          <details data-bee-removed style={{ borderRadius: R.xl, background: T.muted }}>
            <summary style={{ cursor: 'pointer', padding: '12px 16px', fontSize: '13px', lineHeight: '20px', fontWeight: 700, color: T.mutedFg }}>
              Removed bees ({removed.length})
            </summary>
            <div data-slist style={{ padding: '0 16px 4px' }}>
              {removed.map(b => (
                <div key={b.id} data-bee={b.id} style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr) auto', alignItems: 'center', gap: '12px', padding: '8px 0' }}>
                  <Avatar name={b.name} quiet />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ ...nameStyle, color: T.mutedFg }}>{b.name}</span>
                    <span style={emailStyle}>{b.email}</span>
                  </span>
                  <Btn disabled={!!busy} onClick={() => patch(b, { active: true })}>Bring back</Btn>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </Section>
  )
}
