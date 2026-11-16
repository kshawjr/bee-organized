// components/network/ContactSheet.jsx
// ─────────────────────────────────────────────────────────────
// THE CONTACT SHEET (Network & Nurture redesign, slice 4a): what opens when
// a row in the new Network list is tapped.
//
// BEHIND THE GREY. Mounted only by the new list, which only a viewer
// lib/network/access.ts says yes to ever sees (super admins, for now). The
// route it reads and saves through answers 403 to everyone else.
//
// WHAT IT CHANGES. The contact's own fields, nine of them: name, job title,
// company (the text), phone, email, website, how you met, birthday and its
// reminder. Type, partner level and partner stage are SHOWN, plainly not
// editable, with a line saying they change through a confirmation step that
// is still to come (slice 6).
//
// WHAT CAN BE ADDED (slice 4b; lib/network/contact-adds.ts has the rules):
//   · a touchpoint   → POST /api/touchpoints, Bee Hub's own, as the old
//                      record sent it
//   · a follow-up    → POST /api/reminders. It is a reminder, the same row
//                      the Reminders page and Home read. No second system.
//   · tags           → POST / DELETE /api/partner-tags, one call per tag
//                      that changed, picked from Bee Hub's own tag list in
//                      its Relationship / Trade / own sections
//   · a note, the addresses, the company link → this sheet's own save,
//                      which writes that one column and nothing else
// One form is open at a time.
//
// HOW IT SAVES. It never sends "the contact". It sends only the fields the
// person changed in the form, each with what it said when the form opened
// (lib/network/contact-edit.ts changesBetween), to
// PATCH /api/network/contacts/<id>, and the SERVER decides what is written.
// A field left alone is never sent. If nothing changed, nothing is sent.
//
// WHAT IT KEEPS that the design has no place for: addresses, website, the
// linked company (shown as the link it is, never matched from the company
// text), how you met, specialties, relationship, notes and next steps.
// met_date is not read or shown: the date a contact was added is its
// created date.
//
// THE EMPTY SHEET IS THE NORMAL SHEET. 245 of 263 contacts have nothing
// logged, none has a birthday, and most have no tags. So an empty part says
// so in one quiet line, or is not drawn at all; nothing here is styled as a
// warning for being empty.
//
// It closes by its own ✕ or Escape, never by a tap outside it (Bee Hub's
// rule). The look is the design's PersonCard, rebuilt as one stylesheet
// scoped to [data-network-sheet], every colour from the design tokens.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { T, NET, TAG_TONES, FONT, FONT_STYLESHEET_HREF } from '@/components/design/tokens'
import { TYPE_META, LEVEL_META, PARTNER_STAGES, normalizeTypes, partnerLevel, partnerStage, money } from '@/lib/network/types'
import { changesBetween, saveErrorWords } from '@/lib/network/contact-edit'
import {
  ADD_ERROR_WORDS, ADDRESS_MAX, ADDRESS_TYPES, NOTE_MAX, TOUCH_METHODS, TOUCH_OUTCOMES,
  addressFromForm, addressToForm, blankAddress, followUpBody, quickDates, stable, tagChanges, touchpointBody,
} from '@/lib/network/contact-adds'
import { RULED_NOT_SURE_IDS } from '@/lib/network/live-mapping'
import { fixedDateLabel, REMINDER_NOTE_MAX } from '@/lib/reminders'
import { sectionTags } from '@/lib/tags'
import { tagTone } from './NetworkListScreen'

const TYPE_COLOR = { partner: NET.partner, vendor: NET.vendor, nurture: NET.nurture, organization: NET.organization, unsure: NET.unsure }
const TYPE_SOFT = { partner: NET.partnerSoft, vendor: NET.vendorSoft, nurture: NET.nurtureSoft, organization: NET.organizationSoft, unsure: NET.unsureSoft }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const TOUCH_WORDS = { call: 'Call', email: 'Email', sms: 'Text', in_person: 'In person' }

const CSS = `
[data-network-sheet]{position:fixed;inset:0;z-index:400;display:flex;justify-content:flex-end;background:color-mix(in oklab,${T.primary} 30%,transparent);font-family:${FONT.ui};color:${T.foreground};animation:ns-fade 240ms ease-out both}
[data-network-sheet] *{box-sizing:border-box}
[data-network-sheet] button{font-family:inherit;cursor:pointer;border:0;background:none;color:inherit;font-size:inherit;text-align:inherit;padding:0}
[data-network-sheet] button:disabled{cursor:not-allowed;opacity:.5}
[data-network-sheet] :is(button,input,select,a):focus-visible{outline:2px solid ${NET.partner};outline-offset:2px}
[data-network-sheet] .ns-sheet{height:100%;width:100%;max-width:576px;overflow-y:auto;overscroll-behavior-y:contain;background:${T.background};box-shadow:0 24px 60px -20px rgba(26,48,44,.35);animation:ns-in 440ms cubic-bezier(.22,1,.36,1) both;padding-bottom:env(safe-area-inset-bottom,0px)}
@keyframes ns-fade{from{opacity:0}}
@keyframes ns-in{from{transform:translateX(24px);opacity:0}}
[data-network-sheet] .ns-mast{background:${T.card};border-bottom:1px solid ${T.border};padding:8px 24px 20px}
[data-network-sheet] .ns-top{position:sticky;top:0;z-index:3;display:flex;align-items:center;justify-content:space-between;min-height:52px;padding:4px 24px;background:${T.card}}
[data-network-sheet] .ns-eyebrow{font-size:11.2px!important;font-weight:700;text-transform:uppercase;color:${T.mutedFg};margin:0}
[data-network-sheet] .ns-close{display:grid;place-items:center;width:44px;height:44px;margin-right:-10px;border-radius:10px;color:${T.mutedFg}}
[data-network-sheet] .ns-close:hover{background:${T.muted};color:${T.primary}}
[data-network-sheet] .ns-identity{display:flex;align-items:flex-start;gap:14px}
[data-network-sheet] .ns-avatar{display:flex;flex-shrink:0;align-items:center;justify-content:center;width:56px;height:56px;border-radius:999px;background:${T.goldSoft};color:${NET.accentFg};font-size:16px;font-weight:700}
[data-network-sheet] .ns-avatar[data-org]{border-radius:12px;background:${T.sageSoft}}
[data-network-sheet] .ns-name{flex:1;min-width:0}
[data-network-sheet] .ns-name h2{font-family:${FONT.heading};font-size:24px;font-weight:500;line-height:1.25;color:${T.primary};margin:0;overflow-wrap:anywhere}
[data-network-sheet] .ns-name-row{display:flex;align-items:flex-start;gap:8px}
[data-network-sheet] .ns-pencil{display:grid;place-items:center;flex-shrink:0;width:36px;height:36px;border-radius:999px;color:${T.mutedFg}}
[data-network-sheet] .ns-pencil:hover{background:${T.muted};color:${T.primary}}
[data-network-sheet] .ns-role{margin:5px 0 0;font-size:14px;color:${T.foreground};overflow-wrap:anywhere}
[data-network-sheet] .ns-company{margin:3px 0 0;font-size:12px;color:${T.mutedFg};overflow-wrap:anywhere}
[data-network-sheet] .ns-linked{display:inline-block;margin-left:6px;padding:0 6px;border-radius:999px;background:${T.sageSoft};color:${T.primary};font-size:10.5px;font-weight:700}
[data-network-sheet] .ns-types{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
[data-network-sheet] .ns-type{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;border:1px solid;font-size:11px;font-weight:700;white-space:nowrap}
[data-network-sheet] .ns-type i{width:6px;height:6px;border-radius:999px}
[data-network-sheet] .ns-badge{flex-shrink:0;max-width:170px;padding:10px 12px;border-radius:14px;background:${T.goldSoft};border:1px solid color-mix(in oklab,${NET.partner} 40%,transparent);text-align:right}
[data-network-sheet] .ns-badge span{display:block;font-size:10.5px;color:${NET.accentFg}}
[data-network-sheet] .ns-badge strong{display:block;font-family:${FONT.heading};font-size:18px;color:${T.primary}}
[data-network-sheet] .ns-tags{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:16px;padding-top:12px;border-top:1px solid ${T.border}}
[data-network-sheet] .ns-chip{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;font-size:12px;line-height:18px;font-weight:700;white-space:nowrap;border:1px solid}
[data-network-sheet] .ns-quiet{font-size:12.5px;color:${T.mutedFg};margin:0;line-height:1.5}
[data-network-sheet] .ns-tabs{display:flex;gap:4px;padding:0 24px;border-bottom:1px solid ${T.border};position:sticky;top:52px;z-index:2;background:${T.background}}
[data-network-sheet] .ns-tab{position:relative;min-height:44px;padding:0 14px;font-size:14px!important;font-weight:700;color:${T.mutedFg};display:inline-flex;align-items:center;gap:6px}
[data-network-sheet] .ns-tab::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:3px;border-radius:3px 3px 0 0;background:${T.primary};transform:scaleX(0);transition:transform .25s ease}
[data-network-sheet] .ns-tab[aria-selected="true"]{color:${T.primary}}
[data-network-sheet] .ns-tab[aria-selected="true"]::after{transform:scaleX(1)}
[data-network-sheet] .ns-count{font-size:11px;padding:0 6px;border-radius:999px;background:${T.muted};color:${T.primary}}
[data-network-sheet] .ns-body{display:flex;flex-direction:column;gap:16px;padding:20px 24px 32px}
[data-network-sheet] .ns-card{position:relative;border-radius:16px;border:1px solid color-mix(in oklab,${T.border} 80%,transparent);background:${T.card};padding:16px 16px 16px 18px;box-shadow:0 1px 2px rgba(26,48,44,.05),0 6px 18px -12px rgba(26,48,44,.18);overflow:hidden}
[data-network-sheet] .ns-card::before{content:"";position:absolute;inset:0 auto 0 0;width:4px;background:var(--ns-accent,${T.primary})}
[data-network-sheet] .ns-card[data-tone="essentials"]{--ns-accent:${NET.cardEssentials};background:linear-gradient(180deg,${NET.cardEssentialsTint},${T.card} 60%)}
[data-network-sheet] .ns-card[data-tone="partner"]{--ns-accent:${NET.cardPartner};background:linear-gradient(180deg,${NET.cardPartnerTint},${T.card} 60%)}
[data-network-sheet] .ns-card[data-tone="notes"]{--ns-accent:${NET.cardNotes}}
[data-network-sheet] .ns-card[data-tone="referrals"]{--ns-accent:${NET.cardReferrals}}
[data-network-sheet] .ns-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:36px;margin-bottom:8px}
[data-network-sheet] .ns-card-title{white-space:nowrap;font-family:${FONT.heading};font-size:13px;font-weight:800;letter-spacing:.02em;color:${T.primary};margin:0}
[data-network-sheet] .ns-saved{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;background:${T.sageSoft};border:1px solid color-mix(in oklab,${T.primary} 30%,transparent);color:${T.primary};font-size:11px;font-weight:700}
[data-network-sheet] .ns-list{display:grid;grid-template-columns:96px minmax(0,1fr);gap:8px 12px;margin:0;font-size:14px}
[data-network-sheet] .ns-list dt{color:${T.mutedFg}}
[data-network-sheet] .ns-list dd{margin:0;min-width:0;overflow-wrap:anywhere;color:${T.primary}}
[data-network-sheet] .ns-list a{color:${T.primary};text-decoration:underline;text-decoration-color:${T.input};text-underline-offset:3px}
[data-network-sheet] .ns-add{white-space:nowrap;color:${NET.accentFg};font-size:14px!important;min-height:24px}
[data-network-sheet] .ns-add:hover{text-decoration:underline}
[data-network-sheet] .ns-form{display:grid;gap:12px}
[data-network-sheet] .ns-field{display:grid;gap:4px;font-size:12px;color:${T.mutedFg}}
[data-network-sheet] .ns-input{height:44px;width:100%;border-radius:8px;border:1px solid ${T.input};background:${T.card};padding:0 12px;font-size:16px!important;font-family:inherit;color:${T.foreground};outline:none}
[data-network-sheet] .ns-input:focus{border-color:${T.primary}}
[data-network-sheet] .ns-input[aria-invalid="true"]{border-color:${T.destructive}}
[data-network-sheet] .ns-input:disabled{background:${T.muted};color:${T.mutedFg}}
[data-network-sheet] .ns-two{display:grid;grid-template-columns:1fr 1fr;gap:8px}
[data-network-sheet] .ns-check{display:flex;align-items:center;gap:8px;min-height:44px;font-size:13px;color:${T.primary}}
[data-network-sheet] .ns-error{margin:0;font-size:12.5px;color:${T.destructive}}
[data-network-sheet] .ns-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
[data-network-sheet] .ns-btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;border-radius:10px;font-size:13px!important;font-weight:500;text-transform:uppercase}
[data-network-sheet] .ns-btn-primary{background:${T.primary};color:${T.primaryFg}}
[data-network-sheet] .ns-btn-ghost{color:${T.mutedFg}}
[data-network-sheet] .ns-btn-ghost:hover{background:${T.muted};color:${T.primary}}
[data-network-sheet] .ns-steps{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:3px;padding:3px;border-radius:999px;background:color-mix(in oklab,${T.card} 62%,${NET.vendorSoft})}
[data-network-sheet] .ns-step{display:flex;align-items:center;justify-content:center;gap:5px;min-height:52px;padding:0 4px;border-radius:999px;color:${T.mutedFg};text-align:center}
[data-network-sheet] .ns-step[data-current="true"]{background:${T.primary};color:${T.primaryFg}}
[data-network-sheet] .ns-step[data-done="true"]{background:color-mix(in oklab,${NET.vendor} 16%,${T.card});color:${NET.vendor}}
[data-network-sheet] .ns-step b{display:grid;place-items:center;flex-shrink:0;width:16px;height:16px;border:1px solid currentColor;border-radius:50%;font-size:9.5px;font-weight:400}
[data-network-sheet] .ns-step span{min-width:0;overflow-wrap:anywhere;font-size:10.5px;font-weight:600;line-height:1.2}
[data-network-sheet] .ns-rows{display:grid;gap:10px;margin:0;padding:0;list-style:none;font-size:14px;color:${T.primary}}
[data-network-sheet] .ns-rows small{display:block;font-size:12px;color:${T.mutedFg}}
[data-network-sheet] .ns-history{position:relative;display:grid;gap:16px;margin:0;padding:0 0 0 20px;list-style:none}
[data-network-sheet] .ns-history::before{content:"";position:absolute;left:5px;top:6px;bottom:6px;width:2px;background:${T.border}}
[data-network-sheet] .ns-history li{position:relative;font-size:14px;color:${T.primary};overflow-wrap:anywhere}
[data-network-sheet] .ns-history li::before{content:"";position:absolute;left:-20px;top:5px;width:12px;height:12px;border-radius:999px;background:${T.card};border:2px solid ${T.primary}}
[data-network-sheet] .ns-history li[data-kind="touchpoint"]::before{background:${T.primary}}
[data-network-sheet] .ns-history li[data-kind="note"]::before{border-color:${NET.cardNotes}}
[data-network-sheet] .ns-history small{display:block;font-size:12px;color:${T.mutedFg}}
[data-network-sheet] select.ns-input{padding-right:38px;background-image:linear-gradient(45deg,transparent 50%,${T.mutedFg} 50%),linear-gradient(135deg,${T.mutedFg} 50%,transparent 50%);background-position:calc(100% - 21px) 50%,calc(100% - 15px) 50%;background-size:6px 6px;background-repeat:no-repeat}
[data-network-sheet] .ns-area{height:auto;min-height:88px;padding:10px 12px;line-height:1.45;resize:vertical}
[data-network-sheet] .ns-sub{margin:0 0 6px;font-size:11.2px;font-weight:700;text-transform:uppercase;color:${T.mutedFg}}
[data-network-sheet] .ns-sub i{font-style:normal;font-weight:400;text-transform:none;margin-left:6px}
[data-network-sheet] .ns-picks{display:flex;flex-wrap:wrap;gap:8px}
[data-network-sheet] .ns-pick{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:0 14px;border-radius:999px;border:1px solid ${T.input};background:${T.card};color:${T.primary};font-size:13px!important;font-weight:600}
[data-network-sheet] .ns-pick:hover{background:${T.muted}}
[data-network-sheet] .ns-pick[aria-pressed="true"],[data-network-sheet] .ns-pick[aria-checked="true"]{background:${T.primary};border-color:${T.primary};color:${T.primaryFg}}
[data-network-sheet] .ns-doors{display:flex;flex-wrap:wrap;gap:8px}
[data-network-sheet] .ns-door{display:inline-flex;align-items:center;min-height:44px;padding:0 14px;border-radius:10px;border:1px solid ${T.input};background:${T.card};color:${T.primary};font-size:13.5px!important;font-weight:600}
[data-network-sheet] .ns-door:hover{background:${T.muted}}
[data-network-sheet] .ns-block{display:grid;gap:8px;padding:12px;border:1px solid ${T.border};border-radius:12px;background:${T.card}}
[data-network-sheet] .ns-block-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
[data-network-sheet] .ns-three{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr) minmax(0,1fr);gap:8px}
[data-network-sheet] .ns-tagform{margin-top:16px;padding-top:12px;border-top:1px solid ${T.border}}
[data-network-sheet] .ns-problem{margin:20px 24px;padding:16px;border:1px solid ${NET.warn};border-radius:10px;background:${NET.warnSoft};font-size:14px}
@media (max-width:480px){
  [data-network-sheet] .ns-mast{padding:8px 14px 16px}
  [data-network-sheet] .ns-top{padding:4px 14px}
  [data-network-sheet] .ns-tabs{padding:0 14px}
  [data-network-sheet] .ns-body{padding:16px 14px 28px}
  [data-network-sheet] .ns-name h2{font-size:20px}
  [data-network-sheet] .ns-identity{flex-wrap:wrap;gap:10px}
  [data-network-sheet] .ns-badge{max-width:none;flex:1 1 100%;text-align:left}
  [data-network-sheet] .ns-steps{grid-template-columns:minmax(0,1fr);border-radius:14px;padding:4px}
  [data-network-sheet] .ns-step{justify-content:flex-start;gap:10px;min-height:40px;padding:0 12px;border-radius:10px;text-align:left}
  [data-network-sheet] .ns-step span{font-size:13px}
  [data-network-sheet] .ns-three{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
  [data-network-sheet] .ns-three > :first-child{grid-column:1 / -1}
  [data-network-sheet] .ns-pick{min-height:44px}
  [data-network-sheet] .ns-add{display:inline-flex;align-items:center;min-height:44px}
  [data-network-sheet] .ns-card-head{flex-wrap:wrap}
  [data-network-sheet] .ns-name-row{align-items:center}
  [data-network-sheet] .ns-pencil{width:44px;height:44px}
  [data-network-sheet] .ns-list{row-gap:0;align-items:center}
  [data-network-sheet] .ns-list dt,[data-network-sheet] .ns-list dd{min-height:36px;display:flex;align-items:center}
}
@media (prefers-reduced-motion:reduce){[data-network-sheet],[data-network-sheet] *{animation:none!important;transition:none!important}}
`

const Svg = ({ children, size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
const IconX = () => <Svg size={20}><path d="M18 6L6 18M6 6l12 12" /></Svg>
const IconPencil = () => <Svg size={14}><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></Svg>

// Two initials, from words that start with a letter or a digit: "Drew & Bill
// Crowley" is DB, not D&.
export const initialsOf = (name) => String(name || '').replace(/—.*/, '').split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w)).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'them'
const digits = (phone) => String(phone || '').replace(/[^\d+]/g, '')
const webHref = (site) => (/^https?:\/\//i.test(site) ? site : `https://${site}`)
// How a website reads on the sheet: without the scheme or a trailing slash.
// Only how it is SHOWN; the link and the edit form use what is stored.
export const webWords = (site) => String(site || '').replace(/^https?:\/\//i, '').replace(/\/$/, '')

/**
 * "Aug 24, 2026" from a stored time. Anything that is not a real date shows
 * as NOTHING: every entry in partners.activity holds the literal text
 * "Just now" as its time (238 of 238 in production), and printing that would
 * tell an owner a contact was added just now, months after it was.
 */
export function whenLabel(value) {
  if (!value || !/\d{4}-\d{2}-\d{2}/.test(String(value))) return ''
  const t = Date.parse(value)
  return Number.isNaN(t) ? '' : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** One address as a line or two, from either shape the table holds. */
export function addressLines(a) {
  if (!a || typeof a !== 'object') return []
  const street = [a.street, a.apt].filter(Boolean).join(', ')
  const town = [[a.city, a.state].filter(Boolean).join(', '), a.zip].filter(Boolean).join(' ')
  const built = [street, town].filter(Boolean)
  return built.length ? built : [a.value].filter(Boolean)
}

/** Everything that has happened, newest first where a date can be read. */
export function historyOf(contact, touchpoints) {
  const items = []
  for (const t of touchpoints || []) {
    items.push({ kind: 'touchpoint', at: t.occurred_at, text: [t.label || TOUCH_WORDS[t.method] || 'Touchpoint', t.notes].filter(Boolean).join(' — ') })
  }
  for (const n of contact?.notes || []) items.push({ kind: 'note', at: n.ts || n.at, text: n.text, by: n.user })
  // An activity entry's own time is unusable (see whenLabel). The one kind
  // there is, "Added to Network …", was written when the contact was made,
  // so it is dated by the contact's created date; any other entry with no
  // readable time is listed without a date rather than with a wrong one.
  for (const e of contact?.activity || []) {
    const readable = /\d{4}-\d{2}-\d{2}/.test(String(e.ts || ''))
    const added = /^added to network/i.test(String(e.label || ''))
    items.push({ kind: 'event', at: readable ? e.ts : (added ? contact.createdAt : null), text: e.label })
  }
  const time = (x) => { const t = Date.parse(x.at); return Number.isNaN(t) ? -Infinity : t }
  return items.filter((i) => i.text).map((i, n) => ({ ...i, n })).sort((a, b) => time(b) - time(a) || a.n - b.n)
}

function Card({ title, tone, action, saved, children, testId }) {
  return (
    <section className="ns-card" data-tone={tone} data-card={testId}>
      <div className="ns-card-head">
        <h3 className="ns-card-title">{title}</h3>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
          {saved && <span className="ns-saved" role="status" data-saved>{saved}</span>}
          {action}
        </span>
      </div>
      {children}
    </section>
  )
}

const formFrom = (c) => {
  const [month = '', day = ''] = String(c.birthday || '').split(' ')
  return {
    name: c.name || '', title: c.title || '', company: c.company || '',
    phone: c.phone || '', email: c.email || '', website: c.website || '', howWeMet: c.howWeMet || '',
    month, day, birthdayReminder: c.birthdayReminder === true,
    companyId: c.companyId || '',
  }
}
// What each add form starts as.
const draftFor = (which, c, data) => ({
  touchpoint: { method: 'call', status: null, notes: '' },
  note: { text: '' },
  followUp: { dueOn: '', note: '' },
  tags: { picked: (data?.tags || []).map((t) => t.id) },
  addresses: { list: (c.addresses || []).length ? c.addresses.map(addressToForm) : [blankAddress()] },
}[which] || null)
const errorWords = (code) => ADD_ERROR_WORDS[code] || saveErrorWords(code)
const NOT_SAVED = 'That could not be saved. Nothing was changed. Check your connection and try again.'
const IDENTITY_FIELDS = ['name', 'title', 'company']
const ESSENTIAL_FIELDS = ['phone', 'email', 'website', 'howWeMet', 'birthday', 'birthdayReminder']

/**
 * Props
 *   contactId   the contact to open
 *   onClose     () => void
 *   onSaved     (contact) => void, after a save that wrote something
 *   fetchImpl   for tests
 */
export default function ContactSheet({ contactId, onClose, onSaved = () => {}, fetchImpl = null }) {
  const [data, setData] = useState(null)
  const [referral, setReferral] = useState(null)
  const [problem, setProblem] = useState('')
  const [tab, setTab] = useState('details')
  const [editing, setEditing] = useState(null) // 'identity' | 'essentials' | null
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null) // { field, words }
  const [saved, setSaved] = useState(null) // { where, words }
  const [draft, setDraft] = useState(null) // the open add form's boxes (slice 4b)
  const [tagList, setTagList] = useState(null) // { sections } | { problem: true }
  const [companies, setCompanies] = useState(null) // [{ id, name }] | 'problem'
  const sheet = useRef(null)
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null)

  const load = () => {
    setProblem('')
    return doFetch(`/api/network/contacts/${contactId}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
        setData(json)
      })
      .catch((e) => setProblem(String(e?.message || e)))
  }
  // Read the contact again after something was added through another route.
  // A failed re-read is not a failed save, so it never raises the "could not
  // open" line: the sheet keeps what it shows and the answer is null.
  const refresh = () => doFetch(`/api/network/contacts/${contactId}`)
    .then(async (res) => { const json = await res.json().catch(() => null); if (!res.ok || !json?.contact) return null; setData(json); return json })
    .catch(() => null)
  const call = async (url, method, body) => {
    const res = await doFetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { res, json: await res.json().catch(() => ({})) }
  }

  useEffect(() => {
    let alive = true
    setData(null); setReferral(null); setEditing(null); setError(null); setSaved(null); setTab('details'); setDraft(null); setTagList(null); setCompanies(null)
    load()
    // Real referral numbers, from the route the old record already used.
    doFetch(`/api/partners/${contactId}/referrals`)
      .then(async (res) => { const json = await res.json().catch(() => ({})); if (res.ok && alive) setReferral({ count: Number(json.total ?? json.totals?.count) || 0, converted: Number(json.totals?.converted) || 0, revenue: Number(json.totals?.revenue) || 0 }) })
      .catch(() => {})
    return () => { alive = false }
  }, [contactId]) // eslint-disable-line react-hooks/exhaustive-deps

  // The page behind does not scroll while the sheet is open.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  // Escape: leaves the form first, then the sheet. Never while a save is in flight.
  useEffect(() => {
    const key = (e) => {
      if (e.key !== 'Escape' || saving) return
      if (editing) { setEditing(null); setError(null) } else onClose()
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [editing, saving, onClose])

  useEffect(() => {
    if (!saved) return undefined
    const t = setTimeout(() => setSaved(null), 2400)
    return () => clearTimeout(t)
  }, [saved])

  const c = data?.contact
  const types = useMemo(() => normalizeTypes(c?.networkTypes), [c])
  const isPartner = types.includes('partner')
  const isOrg = types.includes('organization')
  const level = c ? partnerLevel({ types, level: c.partnerLevel }) : null
  const stage = c ? partnerStage({ types, stage: c.partnerStage }) : null
  const history = useMemo(() => historyOf(c, data?.touchpoints), [c, data])

  // Bee Hub's own tag list for THIS contact's location (the same read every
  // other tag picker makes), in its Relationship / Trade / own sections.
  const loadTagList = () => {
    setTagList(null)
    doFetch(`/api/lookups?category=tags&location_id=${encodeURIComponent(c.locationId)}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}))
        if (!res.ok || !Array.isArray(json.lookups)) throw new Error('tags')
        const rows = json.lookups.filter((t) => t.is_active !== false)
        setTagList({ sections: sectionTags(rows, json.location?.name ? `${json.location.name}’s own` : null) })
      })
      .catch(() => setTagList({ problem: true }))
  }
  // The companies at THIS contact's location, from the companies table.
  const loadCompanies = () => {
    setCompanies(null)
    doFetch(`/api/companies?location_id=${encodeURIComponent(c.locationId)}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}))
        const rows = Array.isArray(json) ? json : json.rows
        if (!res.ok || !Array.isArray(rows)) throw new Error('companies')
        setCompanies(rows.map((r) => ({ id: r.id, name: r.name })))
      })
      .catch(() => setCompanies('problem'))
  }

  const open = (which) => {
    if (saving) return // one thing at a time: nothing opens while a save is in flight
    setForm(formFrom(c)); setDraft(draftFor(which, c, data)); setEditing(which); setError(null); setSaved(null)
    if (which === 'tags') loadTagList()
    if (which === 'identity' && !isOrg) loadCompanies()
  }
  const cancel = () => { setEditing(null); setError(null) }
  const put = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const putDraft = (k, v) => setDraft((d) => ({ ...d, [k]: v }))
  const putAddress = (i, k, v) => setDraft((d) => ({ list: d.list.map((a, n) => (n === i ? { ...a, [k]: v } : a)) }))

  // One add at a time. `work` answers { words, contact? } or { error }.
  async function run(where, work) {
    setSaving(true); setError(null)
    try {
      const r = await work()
      if (r.error) { setError(r.error); return }
      setEditing(null); setSaved({ where, words: r.words })
      if (r.contact) onSaved(r.contact)
    } catch (e) {
      setError({ field: null, words: NOT_SAVED })
    } finally {
      setSaving(false)
    }
  }
  const refusal = (json, field = null) => ({ error: { field: json?.field || field, words: errorWords(json?.error) } })

  // A touchpoint: Bee Hub's own route, the same request the old record sent.
  const saveTouchpoint = () => run('log', async () => {
    const { res, json } = await call('/api/touchpoints', 'POST', touchpointBody(contactId, draft))
    if (!res.ok) return refusal(json)
    const fresh = await refresh()
    return { words: 'Touchpoint logged', contact: fresh?.contact || c }
  })
  // A note: the sheet's own save; the server appends it to what is stored.
  const saveNote = () => run('log', async () => {
    if (!draft.text.trim()) return { error: { field: 'note', words: errorWords('note_needs_text') } }
    const { res, json } = await call(`/api/network/contacts/${contactId}`, 'PATCH', { addNote: { text: draft.text } })
    if (!res.ok) return refusal(json, 'note')
    setData(json)
    return { words: 'Note added', contact: json.contact }
  })
  // A follow-up IS a reminder: Bee Hub's own reminders route, nothing else.
  const saveFollowUp = () => run('followUp', async () => {
    const b = followUpBody(contactId, draft)
    if (!b.ok) return { error: { field: b.field, words: errorWords(b.error) } }
    const { res, json } = await call('/api/reminders', 'POST', b.body)
    if (!res.ok) return refusal(json)
    const fresh = await refresh()
    return { words: 'Follow-up set. It is on your Reminders page too.', contact: fresh?.contact || c }
  })
  // Tags: one link added or removed per tag that changed, and no others.
  const saveTags = () => run('tags', async () => {
    const { add, remove } = tagChanges((data.tags || []).map((t) => t.id), draft.picked)
    const total = add.length + remove.length
    if (!total) return { words: 'Nothing changed' }
    let failed = 0
    for (const id of add) {
      const { res } = await call('/api/partner-tags', 'POST', { partner_id: contactId, tag_lookup_id: id })
      if (!res.ok) failed += 1
    }
    for (const id of remove) {
      const { res } = await call(`/api/partner-tags?partner_id=${encodeURIComponent(contactId)}&tag_lookup_id=${encodeURIComponent(id)}`, 'DELETE')
      if (!res.ok) failed += 1
    }
    const fresh = await refresh()
    if (failed) {
      if (fresh) setDraft({ picked: (fresh.tags || []).map((t) => t.id) })
      return { error: { field: 'tags', words: `${failed} of ${total} tag ${total === 1 ? 'change' : 'changes'} could not be saved. What is ticked above is what is saved now.` } }
    }
    return { words: 'Tags saved', contact: fresh?.contact || c }
  })
  // Addresses: the list as it was when the form opened, and as it is now.
  const saveAddresses = () => run('addresses', async () => {
    const from = c.addresses || []
    const to = draft.list.map(addressFromForm)
    if (stable(to) === stable(from)) return { words: 'Nothing changed' }
    const { res, json } = await call(`/api/network/contacts/${contactId}`, 'PATCH', { addresses: { from, to } })
    if (!res.ok) { if (res.status === 409) await load(); return refusal(json, 'addresses') }
    setData(json)
    return json.written?.length ? { words: 'Saved', contact: json.contact } : { words: 'Nothing changed' }
  })

  async function save() {
    const fields = editing === 'identity' ? IDENTITY_FIELDS : ESSENTIAL_FIELDS
    const typed = { ...form, birthday: form.month && form.day ? `${form.month} ${form.day}` : '', birthdayReminder: form.birthdayReminder && !!(form.month && form.day) }
    if (editing === 'essentials' && (form.month ? !form.day : form.day)) { setError({ field: 'birthday', words: saveErrorWords('birthday_unreadable') }); return }
    // Only the fields in THIS form, and of those only what the person changed.
    const changes = changesBetween(
      Object.fromEntries(fields.map((f) => [f, c[f]])),
      Object.fromEntries(fields.map((f) => [f, typed[f]])),
    )
    const request = {}
    if (Object.keys(changes).length) request.changes = changes
    // The company LINK rides with the name form, as its own named change.
    if (editing === 'identity' && !isOrg && (form.companyId || '') !== (c.companyId || '')) request.companyId = { from: c.companyId || null, to: form.companyId || null }
    if (Object.keys(request).length === 0) { setEditing(null); setSaved({ where: editing, words: 'Nothing changed' }); return }
    setSaving(true); setError(null)
    try {
      const res = await doFetch(`/api/network/contacts/${contactId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError({ field: json?.field || null, words: errorWords(json?.error) })
        // Someone else changed it: show what it says now, behind the message.
        if (res.status === 409) await load()
        return
      }
      setData(json)
      setSaved({ where: editing, words: json.written?.length ? ['Saved', ...(json.notes || [])].join('. ') : 'Nothing changed' })
      setEditing(null)
      if (json.written?.length) onSaved(json.contact)
    } catch (e) {
      setError({ field: null, words: NOT_SAVED })
    } finally {
      setSaving(false)
    }
  }
  const submit = (fn) => (e) => { e.preventDefault(); if (!saving) fn() }
  const foot = (label = 'Save', busy = 'Saving…', off = false) => (
    <>
      {error && <p className="ns-error" role="alert" data-save-error>{error.words}</p>}
      <div className="ns-actions">
        <button type="button" className="ns-btn ns-btn-ghost" onClick={cancel} disabled={saving} data-cancel>Cancel</button>
        <button type="submit" className="ns-btn ns-btn-primary" disabled={saving || off} aria-busy={saving || undefined} data-save>{saving ? busy : label}</button>
      </div>
    </>
  )
  const companyOptions = Array.isArray(companies)
    ? [...companies, ...(c?.linkedCompany && !companies.some((o) => o.id === c.linkedCompany.id) ? [c.linkedCompany] : [])]
    : (c?.linkedCompany ? [c.linkedCompany] : [])
  const quick = quickDates()

  const input = (field, label, extra = {}) => (
    <label className="ns-field">{label}
      <input className="ns-input" value={form[field]} disabled={saving} aria-invalid={error?.field === field || undefined}
        onChange={(e) => put(field, e.target.value)} data-field={field} {...extra} />
    </label>
  )
  const formFoot = (
    <>
      {error && <p className="ns-error" role="alert" data-save-error>{error.words}</p>}
      <div className="ns-actions">
        <button type="button" className="ns-btn ns-btn-ghost" onClick={cancel} disabled={saving} data-cancel>Cancel</button>
        <button type="submit" className="ns-btn ns-btn-primary" disabled={saving} aria-busy={saving || undefined} data-save>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </>
  )

  return (
    <div data-network-sheet>
      <link rel="stylesheet" href={FONT_STYLESHEET_HREF} />
      <style>{CSS}</style>
      <aside ref={sheet} className="ns-sheet" role="dialog" aria-modal="true" aria-label={c ? `Contact details for ${c.name}` : 'Contact details'} tabIndex={-1} data-contact-sheet={contactId}>
        {/* The close bar stays at the top of the sheet however far it is
            scrolled: on a phone there is no Escape key, and the first
            screenshots showed the ✕ scrolling away with the header. */}
        <div className="ns-top" data-sheet-top>
          <p className="ns-eyebrow">{isOrg ? 'Organization' : 'Contact details'}{c?.locationName ? ` · ${c.locationName}` : ''}</p>
          <button type="button" className="ns-close" onClick={onClose} aria-label="Close contact" title="Close" disabled={saving} data-close><IconX /></button>
        </div>
        <div className="ns-mast">

          {problem && <p className="ns-quiet" role="alert" data-sheet-problem>We couldn&rsquo;t open this contact ({problem}). Nothing has been changed.</p>}
          {!problem && !c && <p className="ns-quiet" data-sheet-loading>Opening…</p>}

          {c && editing === 'identity' && (
            <form className="ns-form" onSubmit={(e) => { e.preventDefault(); save() }} data-form="identity">
              {input('name', 'Name', { required: true, autoFocus: true })}
              {!isOrg && input('title', 'Job title')}
              {!isOrg && input('company', c.linkedCompany ? `Company text (linked company: ${c.linkedCompany.name})` : 'Company')}
              {/* The company LINK: picked from the Companies list at this
                  contact's location. It never reads or changes the text above. */}
              {!isOrg && (
                <label className="ns-field">Linked company
                  <select className="ns-input" value={form.companyId} disabled={saving || !Array.isArray(companies)} onChange={(e) => put('companyId', e.target.value)}
                    aria-invalid={error?.field === 'companyId' || undefined} data-field="companyId">
                    <option value="">No linked company</option>
                    {companyOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                  <span data-company-hint>
                    {companies === null && 'Loading your Companies list…'}
                    {companies === 'problem' && 'Your Companies list could not be loaded, so the link is left as it is.'}
                    {Array.isArray(companies) && (companies.length ? 'Picked from your Companies list. It does not change the company text above.' : 'There are no companies at this location yet.')}
                  </span>
                </label>
              )}
              {formFoot}
            </form>
          )}

          {c && editing !== 'identity' && (
            <>
              <div className="ns-identity">
                <span className="ns-avatar" data-org={isOrg || undefined}>{isOrg ? '🏢' : initialsOf(c.name)}</span>
                <div className="ns-name">
                  <div className="ns-name-row">
                    <h2 data-sheet-name>{c.name}</h2>
                    <button type="button" className="ns-pencil" onClick={() => open('identity')} aria-label={`Edit name, job title and company for ${c.name}`} title="Edit name, job title and company" data-edit="identity"><IconPencil /></button>
                    {saved?.where === 'identity' && <span className="ns-saved" role="status" data-saved>{saved.words}</span>}
                  </div>
                  {!isOrg && c.title && <p className="ns-role" data-sheet-title>{c.title}</p>}
                  {(c.linkedCompany || c.company) && (
                    <p className="ns-company" data-sheet-company>
                      {c.linkedCompany ? c.linkedCompany.name : c.company}
                      {c.linkedCompany && <span className="ns-linked" data-linked-company>Linked company</span>}
                    </p>
                  )}
                  <div className="ns-types" aria-label="Contact types">
                    {types.map((t) => (
                      <span key={t} className="ns-type" data-type={t} style={{ background: TYPE_SOFT[t], color: `color-mix(in oklab, ${TYPE_COLOR[t]} 62%, ${T.primary})`, borderColor: `color-mix(in oklab, ${TYPE_COLOR[t]} 40%, transparent)` }}>
                        <i style={{ background: TYPE_COLOR[t] }} />{TYPE_META[t].label}
                      </span>
                    ))}
                    {c.isCustomer && <span className="ns-quiet" data-also-client style={{ alignSelf: 'center' }}>also a client</span>}
                  </div>
                </div>
                {/* Only when there is something to show. A partner who has sent
                    nobody yet gets no "$0" badge: on the first screenshots it
                    was the loudest thing on an otherwise empty sheet. */}
                {/* And never for the four contacts Kevin ruled are not referral
                    partners, even though a lead still points at one of them. */}
                {referral && referral.count > 0 && !RULED_NOT_SURE_IDS.includes(c.id) && (
                  <div className="ns-badge" aria-label="Work they've sent you" data-referral-badge>
                    <span>Work they&rsquo;ve sent you</span>
                    <strong>{money(referral.revenue)}</strong>
                    <span>{referral.count} {referral.count === 1 ? 'referral' : 'referrals'} · {referral.converted} {referral.converted === 1 ? 'client' : 'clients'}</span>
                  </div>
                )}
              </div>
              {editing === 'tags' ? (
                <form className="ns-form ns-tagform" onSubmit={submit(saveTags)} data-form="tags">
                  {!tagList && <p className="ns-quiet" data-tags-loading>Loading Bee Hub&rsquo;s tags…</p>}
                  {tagList?.problem && <p className="ns-error" role="alert" data-tags-problem>The tag list could not be loaded. Nothing has been changed.</p>}
                  {(tagList?.sections || []).map((s) => (
                    <div key={s.key} role="group" aria-label={s.label} data-tag-section={s.key}>
                      <p className="ns-sub">{s.label}<i>{s.hint}</i></p>
                      <div className="ns-picks">
                        {s.rows.map((t) => {
                          const on = draft.picked.includes(t.id)
                          return <button type="button" key={t.id} className="ns-pick" aria-pressed={on} disabled={saving} data-pick-tag={t.id}
                            onClick={() => setDraft((d) => ({ picked: on ? d.picked.filter((x) => x !== t.id) : [...d.picked, t.id] }))}>{t.label}</button>
                        })}
                      </div>
                    </div>
                  ))}
                  {foot('Save tags', 'Saving…', !tagList?.sections)}
                </form>
              ) : (
                <div className="ns-tags" aria-label="Tags" data-sheet-tags>
                  {(data.tags || []).length === 0
                    ? <p className="ns-quiet">No tags yet.</p>
                    : data.tags.map((t) => { const tone = TAG_TONES[tagTone(t.label)]; return <span key={t.id} className="ns-chip" data-tag={t.id} data-section={t.section} style={{ color: tone.fg, background: tone.bg, borderColor: tone.border }}>{t.label}</span> })}
                  <button type="button" className="ns-add" onClick={() => open('tags')} data-edit="tags">{(data.tags || []).length ? 'Change tags' : '+ add tags'}</button>
                  {saved?.where === 'tags' && <span className="ns-saved" role="status" data-saved>{saved.words}</span>}
                </div>
              )}
            </>
          )}
        </div>

        {c && (
          <>
            <div className="ns-tabs" role="tablist" aria-label="Contact sections">
              <button type="button" role="tab" aria-selected={tab === 'details'} className="ns-tab" onClick={() => setTab('details')} data-tab="details">Details</button>
              <button type="button" role="tab" aria-selected={tab === 'history'} className="ns-tab" onClick={() => setTab('history')} data-tab="history">History <span className="ns-count">{history.length}</span></button>
            </div>

            {tab === 'history' ? (
              <div className="ns-body" data-history>
                {history.length === 0
                  ? <p className="ns-quiet" data-history-empty>Nothing logged with {firstName(c.name)} yet.</p>
                  : <ol className="ns-history">{history.map((h) => (
                      <li key={`${h.kind}-${h.n}`} data-kind={h.kind}>{h.text}<small>{[whenLabel(h.at), h.by].filter(Boolean).join(' · ')}</small></li>
                    ))}</ol>}
              </div>
            ) : (
              <div className="ns-body" data-details>
                <Card title="Contact & Essentials" tone="essentials" testId="essentials" saved={saved?.where === 'essentials' ? saved.words : null}
                  action={editing !== 'essentials' && <button type="button" className="ns-pencil" onClick={() => open('essentials')} aria-label="Edit Contact & Essentials" title="Edit Contact & Essentials" data-edit="essentials"><IconPencil /></button>}>
                  {editing === 'essentials' ? (
                    <form className="ns-form" onSubmit={(e) => { e.preventDefault(); save() }} data-form="essentials">
                      {input('phone', 'Phone', { inputMode: 'tel', autoFocus: true })}
                      {input('email', 'Email', { inputMode: 'email' })}
                      {input('website', 'Website')}
                      {input('howWeMet', 'How you met')}
                      {!isOrg && (
                        <div className="ns-field">Birthday (month and day)
                          <div className="ns-two">
                            <select className="ns-input" aria-label="Birthday month" value={form.month} disabled={saving} aria-invalid={error?.field === 'birthday' || undefined}
                              onChange={(e) => setForm((f) => ({ ...f, month: e.target.value, day: e.target.value ? f.day : '', birthdayReminder: e.target.value ? f.birthdayReminder : false }))} data-field="month">
                              <option value="">No birthday</option>
                              {MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}
                            </select>
                            <select className="ns-input" aria-label="Birthday day" value={form.day} disabled={saving || !form.month} onChange={(e) => put('day', e.target.value)} data-field="day">
                              <option value="">Day</option>
                              {Array.from({ length: form.month ? DAYS_IN[MONTHS.indexOf(form.month)] : 31 }, (_, i) => <option key={i + 1} value={String(i + 1)}>{i + 1}</option>)}
                            </select>
                          </div>
                          <label className="ns-check">
                            <input type="checkbox" checked={form.birthdayReminder && !!(form.month && form.day)} disabled={saving || !(form.month && form.day)} onChange={(e) => put('birthdayReminder', e.target.checked)} data-field="birthdayReminder" />
                            Mark for a birthday reminder
                          </label>
                        </div>
                      )}
                      {formFoot}
                    </form>
                  ) : (
                    <dl className="ns-list" data-essentials>
                      {[
                        ['Phone', c.phone, c.phone ? `tel:${digits(c.phone)}` : null, 'phone'],
                        ['Email', c.email, c.email ? `mailto:${c.email}` : null, 'email'],
                        ['Website', c.website ? webWords(c.website) : null, c.website ? webHref(c.website) : null, 'website'],
                        ['How you met', c.howWeMet, null, 'howWeMet'],
                        ...(isOrg ? [] : [['Birthday', c.birthday ? `${c.birthday}${c.birthdayReminder ? ' · reminder on' : ''}` : null, null, 'birthday']]),
                        // With no address there is no Address card; this line is its way in.
                        ...((c.addresses || []).length ? [] : [['Address', null, null, 'addresses']]),
                      ].map(([label, value, href, key]) => (
                        <React.Fragment key={key}>
                          <dt>{label}</dt>
                          <dd data-value={key}>
                            {value
                              ? (href ? <a href={href} {...(key === 'website' ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{value}</a> : value)
                              : <button type="button" className="ns-add" onClick={() => open(key === 'addresses' ? 'addresses' : 'essentials')} data-add={key}>+ add {label.toLowerCase()}</button>}
                          </dd>
                        </React.Fragment>
                      ))}
                      <dt>Added</dt>
                      <dd data-value="added">{whenLabel(c.createdAt) || '—'}</dd>
                    </dl>
                  )}
                </Card>

                {isPartner && (
                  <Card title="Partner level & stage" tone="partner" testId="partner">
                    <p className="ns-quiet" style={{ marginBottom: '10px' }}>Level: <b style={{ color: T.primary }} data-sheet-level={level}>{LEVEL_META[level].label}</b></p>
                    <div className="ns-steps" role="group" aria-label="Partner stage" aria-disabled="true" data-sheet-stages>
                      {PARTNER_STAGES.map((s, i) => {
                        const at = PARTNER_STAGES.indexOf(stage)
                        const done = at !== PARTNER_STAGES.length - 1 && i < at
                        return <div key={s} className="ns-step" data-current={s === stage} data-done={done} aria-current={s === stage ? 'step' : undefined} title={s}><b>{i + 1}</b><span>{s}</span></div>
                      })}
                    </div>
                    <p className="ns-quiet" style={{ marginTop: '8px' }} data-level-stage-note>Now at <b style={{ color: T.primary }}>{stage}</b>. Level and stage can&rsquo;t be changed from here yet: changing them will ask you to confirm, and that step is still being built.</p>
                  </Card>
                )}

                <Card title="Touchpoints & notes" tone="notes" testId="log" saved={saved?.where === 'log' ? saved.words : null}>
                  {editing === 'touchpoint' && (
                    <form className="ns-form" onSubmit={submit(saveTouchpoint)} data-form="touchpoint">
                      <div role="radiogroup" aria-label="How you were in touch">
                        <p className="ns-sub">How you were in touch</p>
                        <div className="ns-picks">
                          {TOUCH_METHODS.map((m) => <button type="button" key={m.value} role="radio" aria-checked={draft.method === m.value} className="ns-pick" disabled={saving} onClick={() => putDraft('method', m.value)} data-method={m.value}>{m.label}</button>)}
                        </div>
                      </div>
                      <div role="group" aria-label="How it went">
                        <p className="ns-sub">How it went<i>optional</i></p>
                        <div className="ns-picks">
                          {TOUCH_OUTCOMES.map((o) => <button type="button" key={o.value} aria-pressed={draft.status === o.value} className="ns-pick" disabled={saving} onClick={() => putDraft('status', draft.status === o.value ? null : o.value)} data-outcome={o.value}>{o.label}</button>)}
                        </div>
                      </div>
                      <label className="ns-field">Notes (optional)
                        <textarea className="ns-input ns-area" value={draft.notes} disabled={saving} onChange={(e) => putDraft('notes', e.target.value)} data-field="touchNotes" />
                      </label>
                      {foot('Log touchpoint', 'Logging…')}
                    </form>
                  )}
                  {editing === 'note' && (
                    <form className="ns-form" onSubmit={submit(saveNote)} data-form="note">
                      <label className="ns-field">Note
                        <textarea className="ns-input ns-area" value={draft.text} disabled={saving} maxLength={NOTE_MAX} autoFocus aria-invalid={error?.field === 'note' || undefined}
                          onChange={(e) => putDraft('text', e.target.value)} data-field="note" />
                      </label>
                      {foot('Add note', 'Adding…')}
                    </form>
                  )}
                  {editing !== 'touchpoint' && editing !== 'note' && (
                    <>
                      <div className="ns-doors">
                        <button type="button" className="ns-door" onClick={() => open('touchpoint')} data-edit="touchpoint">+ Log a touchpoint</button>
                        <button type="button" className="ns-door" onClick={() => open('note')} data-edit="note">+ Add a note</button>
                      </div>
                      <p className="ns-quiet" style={{ marginTop: '10px' }} data-log-line>
                        {whenLabel(c.lastContactedAt) ? `Last in touch ${whenLabel(c.lastContactedAt)}. ` : ''}
                        {history.length ? `Everything logged is under History (${history.length}).` : `Nothing logged with ${firstName(c.name)} yet.`}
                      </p>
                    </>
                  )}
                </Card>

                {((c.addresses || []).length > 0 || editing === 'addresses') && (
                  <Card title={(c.addresses || []).length > 1 ? 'Addresses' : 'Address'} tone="notes" testId="addresses" saved={saved?.where === 'addresses' ? saved.words : null}
                    action={editing !== 'addresses' && <button type="button" className="ns-pencil" onClick={() => open('addresses')} aria-label="Edit addresses" title="Edit addresses" data-edit="addresses"><IconPencil /></button>}>
                    {editing === 'addresses' ? (
                      <form className="ns-form" onSubmit={submit(saveAddresses)} data-form="addresses">
                        {draft.list.length === 0 && <p className="ns-quiet" data-no-address>No address. Saving now removes the address from this contact.</p>}
                        {draft.list.map((a, i) => (
                          <div className="ns-block" key={i} data-address-block={i}>
                            <div className="ns-block-head">
                              <label className="ns-field" style={{ flex: 1 }}>Kind of address
                                <select className="ns-input" value={a.type} disabled={saving} onChange={(e) => putAddress(i, 'type', e.target.value)} data-field={`type-${i}`}>
                                  {[...ADDRESS_TYPES, ...(ADDRESS_TYPES.includes(a.type) ? [] : [a.type])].map((t) => <option key={t} value={t}>{t}</option>)}
                                </select>
                              </label>
                              <button type="button" className="ns-add" disabled={saving} onClick={() => setDraft((d) => ({ list: d.list.filter((_, n) => n !== i) }))} data-remove-address={i}>Remove</button>
                            </div>
                            {a.full ? (
                              <>
                                <label className="ns-field">Street
                                  <input className="ns-input" value={a.street} disabled={saving} onChange={(e) => putAddress(i, 'street', e.target.value)} data-field={`street-${i}`} />
                                </label>
                                <label className="ns-field">Suite or unit
                                  <input className="ns-input" value={a.apt} disabled={saving} onChange={(e) => putAddress(i, 'apt', e.target.value)} data-field={`apt-${i}`} />
                                </label>
                                <div className="ns-three">
                                  <label className="ns-field">City
                                    <input className="ns-input" value={a.city} disabled={saving} onChange={(e) => putAddress(i, 'city', e.target.value)} data-field={`city-${i}`} />
                                  </label>
                                  <label className="ns-field">State
                                    <input className="ns-input" value={a.state} disabled={saving} onChange={(e) => putAddress(i, 'state', e.target.value)} data-field={`state-${i}`} />
                                  </label>
                                  <label className="ns-field">Zip
                                    <input className="ns-input" value={a.zip} disabled={saving} inputMode="numeric" onChange={(e) => putAddress(i, 'zip', e.target.value)} data-field={`zip-${i}`} />
                                  </label>
                                </div>
                              </>
                            ) : (
                              <label className="ns-field">Address
                                <input className="ns-input" value={a.value} disabled={saving} onChange={(e) => putAddress(i, 'value', e.target.value)} data-field={`value-${i}`} />
                              </label>
                            )}
                          </div>
                        ))}
                        {draft.list.length < ADDRESS_MAX && <button type="button" className="ns-add" disabled={saving} onClick={() => setDraft((d) => ({ list: [...d.list, blankAddress()] }))} data-add-address>{draft.list.length ? '+ add another address' : '+ add an address'}</button>}
                        {foot()}
                      </form>
                    ) : (
                      <ul className="ns-rows" data-addresses>
                        {c.addresses.map((a, i) => (
                          <li key={i}>{a.type && <small>{a.type}</small>}{addressLines(a).map((l, n) => <span key={n} style={{ display: 'block' }}>{l}</span>)}</li>
                        ))}
                      </ul>
                    )}
                  </Card>
                )}

                <Card title="Follow-ups" tone="referrals" testId="follow-ups" saved={saved?.where === 'followUp' ? saved.words : null}
                  action={editing !== 'followUp' && <button type="button" className="ns-add" onClick={() => open('followUp')} data-edit="followUp">+ Set a follow-up</button>}>
                  {/* The follow-ups already set stay on top; the form opens under them. */}
                  {(data.followUps || []).length > 0 && <ul className="ns-rows" data-follow-ups>{data.followUps.map((r) => <li key={r.id}>{r.note || 'Follow up'}<small>{fixedDateLabel(r.due_on)}</small></li>)}</ul>}
                  {editing === 'followUp' && (
                    <form className="ns-form" onSubmit={submit(saveFollowUp)} data-form="followUp" style={{ marginTop: (data.followUps || []).length ? '16px' : 0 }}>
                      <div role="group" aria-label="When">
                        <p className="ns-sub">When</p>
                        <div className="ns-picks">
                          <button type="button" className="ns-pick" aria-pressed={draft.dueOn === quick.tomorrow} disabled={saving} onClick={() => putDraft('dueOn', quick.tomorrow)} data-quick="tomorrow">Tomorrow</button>
                          <button type="button" className="ns-pick" aria-pressed={draft.dueOn === quick.nextWeek} disabled={saving} onClick={() => putDraft('dueOn', quick.nextWeek)} data-quick="nextWeek">Next week</button>
                        </div>
                      </div>
                      <label className="ns-field">Or pick a day
                        <input type="date" className="ns-input" value={draft.dueOn} disabled={saving} aria-invalid={error?.field === 'dueOn' || undefined} onChange={(e) => putDraft('dueOn', e.target.value)} data-field="dueOn" />
                      </label>
                      <label className="ns-field">What it&rsquo;s about
                        <input className="ns-input" value={draft.note} disabled={saving} maxLength={REMINDER_NOTE_MAX} aria-invalid={error?.field === 'note' || undefined} onChange={(e) => putDraft('note', e.target.value)} data-field="followNote" />
                      </label>
                      <p className="ns-quiet">This is one of your reminders. It shows on your Reminders page, and on Home on its day.</p>
                      {foot('Set follow-up', 'Setting…')}
                    </form>
                  )}
                  {(data.followUps || []).length === 0 && editing !== 'followUp' && <p className="ns-quiet" data-follow-ups-empty>No follow-up set. Yours show here and on your Reminders page.</p>}
                </Card>

                {(c.relationship || (c.specialties || []).length > 0 || (c.nextSteps || []).length > 0) && (
                  <Card title="Also on file" tone="notes" testId="on-file">
                    <dl className="ns-list" data-on-file>
                      {c.relationship && <><dt>Relationship</dt><dd>{c.relationship}</dd></>}
                      {(c.specialties || []).length > 0 && <><dt>Specialties</dt><dd>{c.specialties.join(', ')}</dd></>}
                      {(c.nextSteps || []).length > 0 && <><dt>Next steps</dt><dd>{c.nextSteps.map((s, i) => <span key={i} style={{ display: 'block' }}>{s.text}{s.done ? ' (done)' : ''}</span>)}</dd></>}
                    </dl>
                  </Card>
                )}
              </div>
            )}
          </>
        )}
      </aside>
    </div>
  )
}
