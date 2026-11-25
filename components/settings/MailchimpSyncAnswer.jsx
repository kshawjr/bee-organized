'use client'
// components/settings/MailchimpSyncAnswer.jsx
//
// FL-75 SLICE 6 (2026-11-25): what the Mailchimp card shows after "Sync now".
// It only repeats what the server said (POST /api/mailchimp/sync); it decides
// nothing. Every refusal, the switch and the confirmation live in the sending
// engine on the server.
//
//   <SyncConfirm>  the first-sync confirmation: the exact count and audience,
//                  the Mailchimp flows that start when someone is added (all
//                  paused, or the server would have refused), and any tag that
//                  starts a live flow — left off unless ticked, one by one.
//   <SyncResult>   everything else: a refusal in owner words (live flows named,
//                  with how to pause them), a finished run, or a run that
//                  stopped partway — never reported as done.

import { useState } from 'react'
import { T as HT } from '@/components/hive/shared/tokens'
import { firstSyncConfirmCopy } from '@/lib/mailchimp-connection-state'

const n = (x) => Number(x || 0).toLocaleString('en-US')
const people = (x) => `${n(x)} ${x === 1 ? 'person' : 'people'}`
const box = (tone) => ({
  marginTop: '10px', borderRadius: HT.radius.control, padding: '11px 12px',
  background: tone === 'warn' ? HT.state.warning.soft : tone === 'danger' ? HT.state.danger.soft : HT.surface.sunken,
})
const para = { fontSize: '13px', color: HT.ink.primary, lineHeight: 1.6, margin: '0 0 8px' }
const small = { fontSize: '12px', color: HT.ink.secondary, lineHeight: 1.55, margin: '0 0 8px' }
const primaryBtn = (busy) => ({ padding: '8px 14px', background: HT.accent.fg, border: 'none', borderRadius: HT.radius.control, fontFamily: 'inherit', fontWeight: 700, color: HT.accent.onFill, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.7 : 1 })
const quietBtn = { padding: '8px 14px', background: 'transparent', border: HT.border.control, borderRadius: HT.radius.control, fontFamily: 'inherit', fontWeight: 600, color: HT.ink.secondary, cursor: 'pointer' }

function FlowList({ flows, testid }) {
  return (
    <ul data-testid={testid} style={{ margin: '0 0 8px', paddingLeft: '18px' }}>
      {flows.map((f, i) => (
        <li key={i} style={{ fontSize: '13px', color: HT.ink.primary, lineHeight: 1.6 }}>
          <strong>{f.name}</strong> <span style={{ color: HT.ink.muted }}>({f.status === 'sending' ? 'on' : f.status})</span>
        </li>
      ))}
    </ul>
  )
}

export function SyncConfirm({ confirm, syncing, onYes, onCancel }) {
  const [tagsOk, setTagsOk] = useState([])
  const held = confirm.held_tags || []
  const paused = confirm.paused_flows || []
  return (
    <div data-testid="mc-sync-confirm" style={box('warn')}>
      <p style={para}>{firstSyncConfirmCopy(confirm.count, confirm.list_name)}</p>
      {paused.length > 0 ? (
        <>
          <p style={small}>These Mailchimp flows start when someone is added. They are paused, so nobody gets their email. Keep them paused until this finishes:</p>
          <FlowList flows={paused} testid="mc-paused-flows" />
        </>
      ) : (
        <p style={small}>No Mailchimp flow starts when someone is added to this audience.</p>
      )}
      {held.length > 0 && (
        <div data-testid="mc-held-tags" style={{ margin: '0 0 10px' }}>
          <p style={small}>These tags start a flow in Mailchimp that sends an email. They are left off unless you tick them:</p>
          {held.map((h) => {
            const on = tagsOk.includes(h.tag)
            return (
              <label key={h.tag} style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '13px', color: HT.ink.primary, lineHeight: 1.5, margin: '0 0 6px', cursor: 'pointer' }}>
                <input type="checkbox" checked={on} disabled={syncing} aria-label={`Carry the tag ${h.tag}`}
                  onChange={(e) => setTagsOk(e.target.checked ? [...tagsOk, h.tag] : tagsOk.filter((t) => t !== h.tag))}
                  style={{ width: '18px', height: '18px', marginTop: '1px', accentColor: HT.accent.fg }} />
                <span><strong>{h.tag}</strong> — starts {h.flows.map((f) => `“${f}”`).join(', ')} · {people(h.people)}</span>
              </label>
            )
          })}
        </div>
      )}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <button onClick={() => onYes(tagsOk)} disabled={syncing} className="bee-small-action" data-testid="mc-sync-yes" style={primaryBtn(syncing)}>
          {syncing ? 'Syncing…' : `Yes, subscribe ${n(confirm.count)}`}
        </button>
        <button onClick={onCancel} disabled={syncing} className="bee-small-action" style={quietBtn}>Cancel</button>
      </div>
    </div>
  )
}

export function syncResultWords(r, listName) {
  const list = (listName || '').trim() || 'your Mailchimp audience'
  if (!r.ran) {
    if (r.reason === 'sync_not_enabled') return 'Nothing was sent — sending to Mailchimp isn’t switched on for your location yet.'
    if (r.reason === 'signup_flows_live') return `Nothing was sent. These Mailchimp flows send an email the moment someone is added to ${list}, and they are on. Bee Hub sends its own welcome email, so pause them first:`
    if (r.reason === 'not_connected' || r.reason === 'no_audience' || r.reason === 'location_not_found') return 'Nothing was sent — Mailchimp isn’t fully connected for your location.'
    return r.words || 'Nothing was sent. Please try again in a few minutes.'
  }
  const tail = [
    r.already ? `${people(r.already)} ${r.already === 1 ? 'was' : 'were'} already there and left exactly as they were` : null,
    r.failed ? `${people(r.failed)} couldn’t be added` : null,
  ].filter(Boolean).join(' · ')
  if (r.complete === false) {
    const why = String(r.stopped || '').startsWith('flows_changed') ? ' A Mailchimp flow changed while sending, so Bee Hub stopped.' : ''
    return `Stopped partway: added ${people(r.pushed)} to ${list}, ${n(r.remaining)} still to go.${why} Nobody is added twice — press Sync now to carry on.${tail ? ' ' + tail + '.' : ''}`
  }
  if (!r.pushed && !r.already && !r.failed) return `Nothing new to add — everyone ticked is already in ${list}.`
  return `Done: added ${people(r.pushed)} to ${list}.${tail ? ' ' + tail + '.' : ''}`
}

export function SyncResult({ result, listName }) {
  const refused = !result.ran
  const partial = result.ran && result.complete === false
  const flowsLive = result.reason === 'signup_flows_live'
  return (
    <div data-testid="mc-sync-result" style={box(refused || partial ? 'warn' : 'quiet')}>
      <p style={{ ...para, margin: flowsLive || (result.tags_held || []).length ? '0 0 8px' : 0 }}>{syncResultWords(result, listName)}</p>
      {flowsLive && (
        <>
          <FlowList flows={result.must_pause || []} testid="mc-live-flows" />
          <p style={{ ...small, margin: 0 }}>{result.how_to_pause}</p>
        </>
      )}
      {result.ran && (result.tags_held || []).length > 0 && (
        <p style={{ ...small, margin: 0 }}>Left off because they start a Mailchimp flow: {result.tags_held.join(', ')}.</p>
      )}
    </div>
  )
}
