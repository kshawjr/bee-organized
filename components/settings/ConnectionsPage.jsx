// components/settings/ConnectionsPage.jsx
// ─────────────────────────────────────────────────────────────
// Settings → Connections — slice 4 of 4 of the Settings rebuild (2026-11-13,
// the export's `Connections` page in src/components/settings/pages.tsx).
//
// ONE landing page where the nav had three items. A card per connection:
// what it is, the state it is in FOR THIS LOCATION, and a way in to the
// screen that already manages it. Those three screens (SlackCard, JobberCard,
// MailchimpCard in BeeHub.jsx) are untouched and keep the look they had; this
// file is the landing page and the "All connections" link back to it.
//
// THREE THINGS THE EXPORT GOT WRONG ARE NOT COPIED:
//   · It shows Mailchimp as "Coming soon". Mailchimp is LIVE — owners have
//     connected accounts and picked audiences — so it is a card like the
//     other two, with the same states.
//   · Its banner reads "2 connected · 3 coming soon" for everyone. The
//     counts here are this location's own.
//
// GMAIL AND DIALPAD ARE ROADMAP CARDS (Kevin, 2026-11-13: "this is how
// Kevin shows roadmapped features, so it is deliberate"). Greyed, with a
// "Coming soon" chip — the treatment the nav gives Tags and Text messaging —
// and NOT buttons: no Connect, nothing to open, nothing to tab to. Their one
// line says what the feature WILL do, in the design's words. For the record,
// what exists today: the Gmail code in Bee Hub reads ONE head-office mailbox
// through a service account, and nothing for Dialpad exists at all — so
// neither card may ever read as connected, and the banner counts them as
// coming soon, never as connected or as something the owner has left undone.
//
// MARKS. Slack's is Slack's own published mark, already in Bee Hub
// (components/hive/shared/SlackMark.jsx), given the clear space its terms
// ask for. Jobber's, Mailchimp's, Gmail's and Dialpad's are NOT drawn or
// approximated: each is a plain tile with the first letter of the name. To use real logo files
// later, give that entry of MARKS an <img>.
//
// Nothing here decides who may see the page (that is `ownerConfig` in
// BeeHub.jsx's SECTION_GROUPS) and nothing here connects or disconnects
// anything.
// ─────────────────────────────────────────────────────────────
'use client'

import React from 'react'
import { T, R, FONT, HONEYCOMB, SHADOW } from '@/components/design/tokens'
import SlackMark from '@/components/hive/shared/SlackMark'
import { deriveMailchimpState, mailchimpCopy, NOT_LIVE_COPY } from '@/lib/mailchimp-connection-state'
import { Pill, IconCircleCheck, IconChevronRight, IconChevronLeft } from '@/components/settings/SettingsShell'

// ── What each connection is, in this location's own state ─────────────────
// `location` is SettingsScreen's settings.location. Pure: the same input
// always gives the same three cards, and nothing is fetched.
//   state 'connected'  it is set up and working            → counted connected
//   state 'finish'     linked, but something is still owed → counted "to finish"
//   state 'off'        never connected, or disconnected    → counted not connected
// (The roadmap cards, ROADMAP_CARDS below, are not part of this: they have
// no state to work out.)
export function connectionCards(location = {}) {
  const slackOn = !!location.slackConnected
  const slackWhere = [location.slackChannelName ? `#${String(location.slackChannelName).replace(/^#/, '')}` : '', location.slackTeamName || ''].filter(Boolean).join(' · ')

  const jobber = location.jobberStatus || 'disconnected'   // 'connected' | 'reconnect_required' | 'disconnected' (lib/jobber-status)

  const mcState = deriveMailchimpState({ connected: !!location.mailchimpConnected, listId: location.mailchimpListId })
  const mc = mailchimpCopy(mcState, location.mailchimpAccountName)

  return [
    {
      id: 'slack', name: 'Slack', category: 'Team chat',
      desc: 'Post new leads to a channel, and make a channel for a job.',
      state: slackOn ? 'connected' : 'off',
      chip: slackOn ? 'Connected' : 'Not connected',
      detail: slackOn ? slackWhere : '',
    },
    {
      id: 'jobber', name: 'Jobber', category: 'Field service',
      desc: 'Send clients and assessments to Jobber, and bring in the clients you already have.',
      state: jobber === 'connected' ? 'connected' : jobber === 'reconnect_required' ? 'finish' : 'off',
      chip: jobber === 'connected' ? 'Connected' : jobber === 'reconnect_required' ? 'Reconnect required' : 'Not connected',
      detail: jobber === 'disconnected' ? '' : (location.jobberAccountName || ''),
    },
    {
      id: 'mailchimp', name: 'Mailchimp', category: 'Marketing',
      desc: 'Choose which Mailchimp audience your clients belong to.',
      state: mcState === 'ready' ? 'connected' : mcState === 'needs_audience' ? 'finish' : 'off',
      // The words the Mailchimp screen itself uses: Connected / Finish setting up / Not connected.
      chip: mc.badge,
      detail: mcState === 'ready' ? (location.mailchimpListName || location.mailchimpAccountName || '')
        : mcState === 'needs_audience' ? (location.mailchimpAccountName || '') : '',
    },
  ]
}

// What is on the roadmap. The same for every location: there is nothing to
// connect, so there is nothing to look up. state 'soon' is never counted as
// connected, to finish or not connected.
export const ROADMAP_CARDS = [
  { id: 'gmail', name: 'Gmail', category: 'Email', desc: 'Send client emails from your own Gmail address.', state: 'soon', chip: 'Coming soon', detail: '' },
  { id: 'dialpad', name: 'Dialpad', category: 'Phone & texts', desc: 'Log calls and send texts from your business line.', state: 'soon', chip: 'Coming soon', detail: '' },
]

// "2 connected · 1 to finish · 2 coming soon" — only the parts that are not
// zero, and its own words when nothing is connected at all, which is what a
// new franchise sees. `cards` is everything on the page; a roadmap card
// (state 'soon') is counted as coming soon and as nothing else.
export function connectionSummary(cards) {
  const n = s => cards.filter(c => c.state === s).length
  const connected = n('connected'), finish = n('finish'), off = n('off'), soon = n('soon')
  const comingSoon = soon ? `${soon} coming soon` : ''
  if (!connected && !finish) return ['Nothing connected yet', comingSoon].filter(Boolean).join(' · ')
  return [
    connected ? `${connected} connected` : '',
    finish ? `${finish} to finish` : '',
    off ? `${off} not connected` : '',
    comingSoon,
  ].filter(Boolean).join(' · ')
}

// The Mailchimp screen's own sentence about a location whose sync has not
// been switched on, without its leading "Connected." (the chip says that).
export const MAILCHIMP_NOT_SYNCING = NOT_LIVE_COPY.replace(/^Connected\.\s*/, '')

// ── Marks ─────────────────────────────────────────────────────────────────
// A 48px tile. Slack's mark is 24px inside it, which leaves 12px on every
// side — more than the 0.473 × size its brand terms ask for.
const tile = { display:'grid', placeItems:'center', width:'48px', height:'48px', flexShrink:0, borderRadius:R.xl, border:`1px solid ${T.border}`, background:T.card, boxShadow:SHADOW.field }
const letterTile = { ...tile, background:T.sageSoft, border:'1px solid transparent', boxShadow:'none', color:T.primary, fontFamily:FONT.heading, fontSize:'20px', lineHeight:1, fontWeight:700 }
const MARKS = {
  slack: () => <span aria-hidden="true" data-mark="slack" style={tile}><SlackMark size={24} /></span>,
  // Not their logos. A letter on a plain tile, on purpose.
  jobber: () => <span aria-hidden="true" data-mark="letter" style={letterTile}>J</span>,
  mailchimp: () => <span aria-hidden="true" data-mark="letter" style={letterTile}>M</span>,
  gmail: () => <span aria-hidden="true" data-mark="letter" style={letterTile}>G</span>,
  dialpad: () => <span aria-hidden="true" data-mark="letter" style={letterTile}>D</span>,
}

const CHIP_TONE = { connected: 'ok', finish: 'warn', off: 'quiet' }
const cardBox = { display:'flex', flexDirection:'column', alignItems:'stretch', minWidth:0, padding:'20px', borderRadius:R.xxl, border:`1px solid ${T.border}`, background:T.card, fontFamily:FONT.ui, textAlign:'left' }

// ── The page ──────────────────────────────────────────────────────────────
// `onOpen(id)` opens that connection's existing screen. `locationId` is the
// location's real id (null when viewing a location you are not signed in to).
export function ConnectionsPage({ location, locationId, onOpen }) {
  const live3 = connectionCards(location)
  const cards = [...live3, ...ROADMAP_CARDS]
  const mailchimp = live3.find(c => c.id === 'mailchimp')

  // Is Mailchimp's sync switched on for this location? The same question,
  // asked the same way, as the Mailchimp screen asks it — and only when
  // there is a finished connection to ask about. null = not known: say nothing.
  const [live, setLive] = React.useState(null)
  React.useEffect(() => {
    if (mailchimp.state !== 'connected' || !locationId) { setLive(null); return }
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/mailchimp/status?location_id=' + encodeURIComponent(locationId))
        if (!r.ok) return
        const j = await r.json()
        if (!cancelled) setLive(j.live === true)
      } catch { /* unknown stays unknown */ }
    })()
    return () => { cancelled = true }
  }, [mailchimp.state, locationId])

  return <>
    <div data-connections-banner style={{ borderRadius:R.xxl, border:`1px solid ${T.border}`, backgroundColor:T.card, backgroundImage:HONEYCOMB, padding:'20px' }}>
      <p style={{ fontSize:'11px', lineHeight:'16px', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.14em', color:T.gold, fontFamily:FONT.ui }}>Your connections</p>
      <p data-connections-summary style={{ marginTop:'2px', fontSize:'20px', lineHeight:'28px', fontWeight:300, color:T.foreground, fontFamily:FONT.heading }}>{connectionSummary(cards)}</p>
    </div>

    <div data-scards>
      {cards.map(c => {
        const Mark = MARKS[c.id]
        // A ROADMAP card. The nav's treatment for a closed item (Tags, Text
        // messaging), at card size: the words at half strength, a muted
        // "Coming soon" chip at full strength so it can be read, and a plain
        // <div> — not a button, no Connect, nothing to open or tab to.
        if (c.state === 'soon') return (
          <div key={c.id} data-connection={c.id} data-state="soon" data-soon="" aria-disabled="true"
            style={{ ...cardBox, cursor:'default' }}>
            <span style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:'8px' }}>
              <span style={{ opacity:0.5 }}><Mark /></span>
              <span data-connection-chip data-soon-chip style={{ borderRadius:R.full, background:T.muted, padding:'2px 8px', fontSize:'11px', lineHeight:'16px', fontWeight:700, whiteSpace:'nowrap', color:T.mutedFg }}>{c.chip}</span>
            </span>
            <span style={{ display:'block', opacity:0.5 }}>
              <span style={{ display:'block', marginTop:'16px', fontSize:'16px', lineHeight:'24px', fontWeight:700, color:T.foreground }}>{c.name}</span>
              <span style={{ display:'block', fontSize:'11px', lineHeight:'16px', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.12em', color:T.mutedFg }}>{c.category}</span>
              <span style={{ display:'block', marginTop:'8px', fontFamily:FONT.body, fontSize:'13px', lineHeight:1.625, color:T.mutedFg }}>{c.desc}</span>
            </span>
          </div>
        )
        const note = c.id === 'mailchimp' && c.state === 'connected' && live === false ? MAILCHIMP_NOT_SYNCING : ''
        return (
          <button key={c.id} type="button" data-scard data-connection={c.id} data-state={c.state} onClick={() => onOpen(c.id)}
            aria-label={`${c.name}: ${c.chip}. ${c.state === 'off' ? 'Connect' : 'Manage'}`}
            style={{ ...cardBox, cursor:'pointer', transition:'border-color .15s, box-shadow .15s, transform .15s' }}>
            <span style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:'8px' }}>
              <Mark />
              <Pill tone={CHIP_TONE[c.state]} data-connection-chip>{c.state === 'connected' && <IconCircleCheck size={12} />}{c.chip}</Pill>
            </span>
            <span style={{ display:'block', marginTop:'16px', fontSize:'16px', lineHeight:'24px', fontWeight:700, color:T.foreground }}>{c.name}</span>
            <span style={{ display:'block', fontSize:'11px', lineHeight:'16px', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.12em', color:T.mutedFg }}>{c.category}</span>
            <span style={{ display:'block', flex:1, marginTop:'8px', fontFamily:FONT.body, fontSize:'13px', lineHeight:1.625, color:T.mutedFg }}>{c.desc}</span>
            {c.detail && <span data-connection-detail style={{ display:'block', marginTop:'8px', fontSize:'13px', lineHeight:'18px', color:T.foreground, overflowWrap:'anywhere' }}>{c.detail}</span>}
            {note && <span data-connection-note style={{ display:'block', marginTop:'8px', borderRadius:R.md, background:T.warningSoft, padding:'8px 12px', fontSize:'12px', lineHeight:1.5, color:T.warning }}>{note}</span>}
            <span data-connection-action style={{ display:'inline-flex', alignItems:'center', gap:'4px', marginTop:'16px', fontSize:'14px', lineHeight:'20px', fontWeight:700, color:T.primary }}>
              {c.state === 'off' ? 'Connect' : 'Manage'}<IconChevronRight size={16} style={{ verticalAlign:0 }} />
            </span>
          </button>
        )
      })}
    </div>
  </>
}

// ── "All connections" ─────────────────────────────────────────────────────
// Sits above a connection's own (unrebuilt) screen. The only new thing on
// that screen; it carries [data-settings-ui] itself so it gets this look
// while everything under it keeps the one it had.
export function ConnectionsBack({ onBack }) {
  return (
    <div data-settings-ui data-connections-back style={{ padding:'12px 12px 0', fontFamily:FONT.ui }}>
      <button type="button" data-shover="fade" onClick={onBack}
        style={{ display:'inline-flex', alignItems:'center', gap:'6px', minHeight:'44px', padding:'0 4px', border:'none', background:'transparent', color:T.mutedFg, cursor:'pointer', fontFamily:'inherit' }}>
        <IconChevronLeft size={16} />
        <span style={{ fontSize:'14px', lineHeight:'20px', fontWeight:500 }}>All connections</span>
      </button>
    </div>
  )
}
