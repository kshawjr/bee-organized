'use client'
// components/settings/MailchimpSyncAnswer.jsx
//
// FL-75 SLICE 6 (2026-11-25): what the Mailchimp card shows after "Sync now".
// It only repeats what the server said (POST /api/mailchimp/sync); it decides
// nothing. Every refusal, the switch and the confirmation live in the sending
// engine on the server.
//
//   (The first-sync confirmation moved to BeforeWeAdd in
//   MailchimpConnectionScreen.jsx, built to Kevin's Lovable design.)
//   <SyncResult>   everything else: a refusal in owner words (live flows named,
//                  with how to pause them), a finished run, or a run that
//                  stopped partway — never reported as done.

import { T as HT } from '@/components/hive/shared/tokens'

const n = (x) => Number(x || 0).toLocaleString('en-US')
const people = (x) => `${n(x)} ${x === 1 ? 'person' : 'people'}`
const box = (tone) => ({
  marginTop: '10px', borderRadius: HT.radius.control, padding: '11px 12px',
  background: tone === 'warn' ? HT.state.warning.soft : tone === 'danger' ? HT.state.danger.soft : HT.surface.sunken,
})
const para = { fontSize: '13px', color: HT.ink.primary, lineHeight: 1.6, margin: '0 0 8px' }
const small = { fontSize: '12px', color: HT.ink.secondary, lineHeight: 1.55, margin: '0 0 8px' }

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

export function syncResultWords(r, listName) {
  const list = (listName || '').trim() || 'your Mailchimp audience'
  if (!r.ran) {
    if (r.reason === 'sync_not_enabled') return 'Nothing was sent — sending to Mailchimp isn’t switched on for your location yet.'
    if (r.reason === 'signup_flows_live') return `Nothing was sent. These Mailchimp flows send an email the moment someone is added to ${list}, and they are on. Bee Hub sends its own welcome email, so pause them first:`
    if (r.reason === 'not_connected' || r.reason === 'no_audience' || r.reason === 'location_not_found') return 'Nothing was sent — Mailchimp isn’t fully connected for your location.'
    return r.words || 'Nothing was sent. Please try again in a few minutes.'
  }
  // Every number here is the server's own (2026-11-26: refused people are
  // remembered, so they are not sent again silently — the line says so).
  const saidNo = Number(r.said_no ?? r.saidNo ?? 0)
  const held = Number(r.held_back ?? r.heldBack ?? 0)
  const tail = [
    r.already ? `${people(r.already)} ${r.already === 1 ? 'was' : 'were'} already there and left exactly as they were` : null,
    r.failed ? `${people(r.failed)} couldn’t be added — Mailchimp refused them (see who on the Mailchimp screen)` : null,
    saidNo ? `${people(saidNo)} had said no in Mailchimp (unsubscribed, bounced or removed), so they are now on your no-marketing list` : null,
    held ? `${people(held)} Mailchimp refused before ${held === 1 ? 'wasn’t' : 'weren’t'} sent again` : null,
  ].filter(Boolean).join(' · ')
  if (r.complete === false) {
    const why = String(r.stopped || '').startsWith('flows_changed') ? ' A Mailchimp flow changed while sending, so Bee Hub stopped.' : ''
    return `Stopped partway: added ${people(r.pushed)} to ${list}, ${n(r.remaining)} still to go.${why} Nobody is added twice — press Sync now to carry on.${tail ? ' ' + tail + '.' : ''}`
  }
  if (!r.pushed && !r.already && !r.failed && !saidNo) {
    return held ? `Nothing new to add. ${tail}.` : `Nothing new to add — everyone ticked is already in ${list}.`
  }
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
