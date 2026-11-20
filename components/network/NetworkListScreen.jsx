// components/network/NetworkListScreen.jsx
// ─────────────────────────────────────────────────────────────
// THE NEW NETWORK LIST (Network & Nurture redesign, slice 3).
//
// BEHIND THE GREY. Only a viewer lib/network/access.ts says yes to ever
// mounts this (super admins, for now). For everyone else components/
// BeeHub.jsx shows Network closed, exactly as before, and the route this
// screen reads answers 403.
//
// READ-ONLY. This screen reads two addresses and writes nothing:
//   /api/network/list      the contacts, their tags, the viewer's reminders
//   /api/network/summary   real referral numbers (the route the old screen
//                          already used)
// It cannot change a contact's type, level or stage: there is no control
// here that could. Opening a contact hands its id to the host, which opens
// the EXISTING record; the new contact sheet is slice 4.
//
// THE RULES ARE NOT HERE. Types, levels, stages, search, filters, grouping
// and paging all come from lib/network/. This file is the look.
//
// THE LOOK is Kevin's Lovable design (kshawjr/brief-and-current,
// NetworkList.tsx + styles.css), rebuilt without Tailwind or Radix: the
// design's own class rules, rewritten below as one scoped stylesheet. Every
// rule starts with [data-network-ui], so nothing outside this screen is
// touched, and every colour comes from components/design/tokens.js.
// Lato and Arvo are asked for by this screen itself (FONT_STYLESHEET_HREF),
// never app-wide.
//
// ONE DEPARTURE FROM THE DESIGN'S LAYOUT, on a phone: there the design puts
// Filters at the far end of the row of type pills, which scrolls sideways, so
// the button starts off the screen. Here only the pills scroll and Filters
// stays put at the right edge. (Found by looking at the 390px screenshot.)
//
// SLICE 6 (2026-11-19):
//   · EXPORT lives in the header's More menu: it is rare (Kevin), so it is not
//     a main button. The same Menu as Add contacts (closes on a choice, on its
//     button again, on Escape, or on a click outside: Kevin, 2026-11-19).
//   · BULK ACTIONS, inside one location only: tick contacts (or a whole page),
//     then add or take off a tag, or set a Referral partner's level or stage.
//     ONE confirmation for the whole selection (ConfirmChange); Cancel sends
//     nothing. The server (POST /api/network/contacts/bulk) refuses without
//     the yes and writes only the contacts that really change. Follow-ups
//     and anything Mailchimp/drip are not bulk actions (lib/network/bulk.ts).
//   · ONE STAGE IS NORMAL: 50 of 56 Referral partners sit at New Contact, so
//     the Referral partner group says so in one line ("All 50 at New
//     Contact") instead of drawing four empty columns.
//   · A contact with NO TYPE stored (made on the old screen) shows as Not sure
//     yet, as it always has (lib/network/types.ts normalizeTypes). Nothing is
//     written to them.
//
// What the design's list has that this slice leaves out, on purpose: the
// Board view, bulk selection, the sort menu, Mailchimp marks and the People /
// Companies switch. They belong to later slices or to data Bee Hub does not
// hold yet.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { T, NET, TAG_TONES, FONT, FONT_STYLESHEET_HREF } from '@/components/design/tokens'
import { TYPE_META, LEVEL_META, PARTNER_LEVELS, PARTNER_STAGES, NET_TYPES, contactTypes, hasType, isOrganization, isReferralPartner, partnerLevel, partnerStage, money, talkedLabel, COLD_AFTER_DAYS } from '@/lib/network/types'
import { contactSecondaryDetails } from '@/lib/network/filters'
import { PAGE_SIZES, clampPage, contactPage, defaultPageSize, pageCount } from '@/lib/network/paging'
import { fixedDateLabel } from '@/lib/reminders'
import { NO_FILTERS, anyFilterOn, applyListFilters, contactFromRow, dueForFollowUp, groupForList, menuFilterCount, tagsInUse, typeCounts } from '@/lib/network/list'
import { downloadText, exportFileName, exportText } from '@/lib/network/csv-download'
import AddContactDialog from './AddContactDialog'
import ConfirmChange from './ConfirmChange'
import { BULK_ERROR_WORDS, bulkActionWords } from '@/lib/network/bulk'
import { networkTagsFor } from '@/lib/network/contact-create'
import ImportDialog from './ImportDialog'

const TYPE_COLOR = { partner: NET.partner, vendor: NET.vendor, nurture: NET.nurture, organization: NET.organization, unsure: NET.unsure }
// The group heading's stripe and tint, as the design tones them.
const TONE = {
  partner: { accent: NET.accentFg, tint: T.goldSoft },
  unsure: { accent: NET.nurture, tint: NET.nurtureSoft },
  other: { accent: NET.vendor, tint: T.sageSoft },
}
const toneOf = (type) => TONE[type] || TONE.other

/** The design's tag hue: the same name always lands on the same one of six. */
export function tagTone(tag) {
  let h = 0
  for (const c of String(tag)) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h % 6
}

const CSS = `
[data-network-ui]{font-family:${FONT.ui};color:${T.foreground};background:${T.background};min-height:100vh;-webkit-tap-highlight-color:transparent}
[data-network-ui] *{box-sizing:border-box}
[data-network-ui] button{font-family:inherit;cursor:pointer;border:0;background:none;color:inherit;font-size:inherit;text-align:inherit;padding:0}
[data-network-ui] button:disabled{cursor:not-allowed;opacity:.4}
[data-network-ui] :is(button,input,select):focus-visible{outline:2px solid ${NET.partner};outline-offset:2px}
[data-network-ui] .nw-wrap{width:100%;max-width:1152px;margin:0 auto;padding:24px 32px 40px}
[data-network-ui] .nw-eyebrow{font-size:11.2px!important;font-weight:700;text-transform:uppercase;color:${T.mutedFg};margin:0}
[data-network-ui] .nw-title{font-family:${FONT.heading};font-size:30px;font-weight:300;line-height:1.2;color:${T.primary};margin:6px 0 0}
[data-network-ui] .nw-lede{font-family:${FONT.body};font-size:14px;line-height:1.6;color:${T.mutedFg};margin:6px 0 0}
[data-network-ui] .nw-preview{display:inline-flex;align-items:center;gap:6px;margin-top:12px;padding:5px 10px;border:1px dashed ${T.input};border-radius:999px;font-size:12px!important;color:${T.mutedFg};background:${T.card}}
[data-network-ui] .nw-toolbar{margin-top:20px}
[data-network-ui] .nw-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:16px}
[data-network-ui] .nw-act{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 16px;border-radius:10px;border:1px solid ${T.input};background:${T.card};color:${T.primary};font-size:14px!important;font-weight:700;white-space:nowrap}
[data-network-ui] .nw-act:hover:not(:disabled){border-color:${T.primary}}
[data-network-ui] .nw-act[data-primary]{background:${T.primary};border-color:${T.primary};color:${T.primaryFg}}
[data-network-ui] .nw-act-note{flex-basis:100%;margin:0;font-size:12.5px;color:${T.mutedFg}}
[data-network-ui] .nw-add-menu{width:min(320px,calc(100vw - 32px));padding:6px}
[data-network-ui] .nw-add-choice{display:grid;gap:2px;width:100%;min-height:56px;padding:10px 12px!important;border-radius:10px;border:0!important;background:transparent;text-align:left!important;color:${T.primary}}
[data-network-ui] .nw-add-choice:hover,[data-network-ui] .nw-add-choice:focus-visible{background:${T.sageSoft}}
[data-network-ui] .nw-add-choice b{font-size:14px}
[data-network-ui] .nw-add-choice span{font-size:12.5px;line-height:1.35;color:${T.mutedFg}}
[data-network-ui] .nw-more-menu{width:min(280px,calc(100vw - 32px));padding:6px}
@media (max-width:600px){ [data-network-ui] .nw-actions{position:relative} [data-network-ui] .nw-anchor.nw-more-anchor{position:static} [data-network-ui] .nw-more-anchor .nw-menu{left:0;right:auto} }
[data-network-ui] .nw-actions .nw-act:not([data-primary]){gap:4px}
[data-network-ui] .nw-row-wrap{display:flex;align-items:stretch;min-width:0;border-bottom:1px solid ${T.border}}
[data-network-ui] .nw-row-wrap:last-child{border-bottom:0}
[data-network-ui] .nw-row-wrap[data-even]{background:color-mix(in oklab,var(--nw-tint) 32%,${T.card})}
[data-network-ui] .nw-row-wrap[data-selected]{background:color-mix(in oklab,${T.primary} 9%,${T.card})}
[data-network-ui] .nw-row-wrap > .nw-row{flex:1;border-bottom:0!important;background:transparent!important}
[data-network-ui] .nw-row-wrap > button.nw-row:hover{background:color-mix(in oklab,${T.muted} 60%,transparent)!important}
[data-network-ui] .nw-check{display:flex;align-items:center;justify-content:center;flex:0 0 44px;cursor:pointer}
[data-network-ui] .nw-check input,[data-network-ui] .nw-select-page input{width:18px;height:18px;accent-color:${T.primary};cursor:pointer}
[data-network-ui] .nw-select-page{display:flex;align-items:center;gap:10px;padding:8px 13px;border-bottom:1px solid ${T.border};font-size:12.5px;color:${T.mutedFg};cursor:pointer}
[data-network-ui] .nw-stage-line{margin:0;padding:8px 16px;border-bottom:1px solid ${T.border};font-size:12.5px;color:${T.mutedFg};background:${T.card}}
[data-network-ui] .nw-stage-line b{color:${T.primary};font-weight:700}
[data-network-ui] .nw-bulk{position:fixed;left:32px;right:32px;margin:0 auto;max-width:1088px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:40;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;border-radius:14px;background:${T.primary};color:${T.primaryFg};box-shadow:0 12px 30px -12px rgba(26,48,44,.5)}
[data-network-ui] .nw-bulk b{font-size:14px;margin-right:4px}
[data-network-ui] .nw-bulk select{min-height:40px;max-width:100%;border-radius:8px;border:1px solid color-mix(in oklab,${T.primaryFg} 40%,transparent);background:color-mix(in oklab,${T.primaryFg} 12%,${T.primary});color:${T.primaryFg};padding:0 8px;font-family:inherit;font-size:13px!important}
[data-network-ui] .nw-bulk select option{color:${T.primary};background:${T.card}}
[data-network-ui] .nw-bulk button{min-height:40px;padding:0 12px;border-radius:8px;border:1px solid color-mix(in oklab,${T.primaryFg} 40%,transparent);background:transparent;color:${T.primaryFg};font-size:13px!important;font-weight:700;margin-left:auto}
[data-network-ui] .nw-wrap[data-bulk-open]{padding-bottom:140px}
@media (min-width:768px){ [data-network-ui] .nw-bulk{left:calc(var(--bee-rail-w,0px) + 32px)} }
@media (max-width:600px){ [data-network-ui] .nw-bulk{left:16px;right:16px;bottom:calc(8px + env(safe-area-inset-bottom,0px))} [data-network-ui] .nw-bulk select{flex:1 1 40%} [data-network-ui] .nw-bulk button{margin-left:0} }
[data-network-ui] .nw-act-note[data-tone="good"]{color:${T.primary}}
[data-network-ui] .nw-controls{display:flex;align-items:center;gap:16px}
[data-network-ui] .nw-search{position:relative;flex:1;min-width:0}
[data-network-ui] .nw-input{height:44px;width:100%;border-radius:8px;border:1px solid ${T.input};background:${T.card};padding:0 12px;font-size:14px!important;font-family:inherit;color:${T.foreground};outline:none}
[data-network-ui] .nw-input:focus{border-color:${T.primary}}
[data-network-ui] .nw-input::placeholder{color:${T.mutedFg};opacity:.75}
[data-network-ui] .nw-anchor{position:relative;display:flex}
[data-network-ui] .nw-tags-anchor{flex:0 0 200px}
[data-network-ui] .nw-trigger{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 12px;border:1px solid ${T.input};border-radius:8px;background:${T.card};color:${T.primary};font-size:14px!important;font-weight:700;white-space:nowrap;transition:border-color .15s,box-shadow .15s;flex:1}
[data-network-ui] .nw-trigger:hover{border-color:${T.primary}}
[data-network-ui] .nw-trigger[data-active]{border-color:${T.primary};background:color-mix(in oklab,${T.primary} 8%,${T.card})}
[data-network-ui] .nw-trigger-count{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:${T.primary};color:${T.primaryFg};font-size:11px}
[data-network-ui] .nw-refine{display:flex;align-items:center;gap:10px;margin-top:12px;padding-bottom:12px;border-bottom:1px solid ${T.border};flex-wrap:wrap}
[data-network-ui] .nw-pills{display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap}
[data-network-ui] .nw-pill{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 12px;border:1px solid ${T.border};border-radius:999px;background:${T.card};white-space:nowrap;font-size:13px!important;color:${T.mutedFg};transition:background-color 150ms,color 150ms,border-color 150ms}
[data-network-ui] .nw-pill:hover{background:${T.muted};color:${T.primary}}
[data-network-ui] .nw-pill span{font-size:11px;color:${T.mutedFg};font-variant-numeric:tabular-nums}
[data-network-ui] .nw-pill[aria-selected="true"]{background:${T.primary};color:${T.background};border-color:${T.primary};font-weight:700}
[data-network-ui] .nw-pill[aria-selected="true"] span{color:inherit;opacity:.8}
[data-network-ui] .nw-menu-row{display:flex;gap:8px;flex-shrink:0;margin-left:auto;padding-left:10px;border-left:1px solid ${T.border}}
[data-network-ui] .nw-refine .nw-trigger{min-height:36px;border-radius:999px;font-size:13px!important}
[data-network-ui] .nw-menu{position:absolute;top:calc(100% + 6px);left:0;z-index:60;width:min(320px,calc(100vw - 24px));background:${T.card};border:1px solid ${T.border};border-radius:14px;overflow:hidden;box-shadow:0 1px 2px rgba(42,48,43,.06),0 8px 24px -12px rgba(42,48,43,.14),0 18px 40px -18px color-mix(in oklab,${T.primary} 40%,transparent);animation:nw-menu-in .15s ease-out}
[data-network-ui] .nw-menu-row .nw-menu,[data-network-ui] .nw-tags-anchor .nw-menu{left:auto;right:0}
@keyframes nw-menu-in{from{opacity:0;transform:translateY(-4px)}}
[data-network-ui] .nw-menu-body{max-height:60vh;overflow-y:auto;padding:6px 0}
[data-network-ui] .nw-menu-section + .nw-menu-section{border-top:1px solid ${T.border};margin-top:4px;padding-top:4px}
[data-network-ui] .nw-menu-title{padding:8px 14px 4px;font-size:11px!important;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${T.mutedFg};margin:0}
[data-network-ui] .nw-option{display:flex;align-items:center;gap:10px;width:100%;min-height:40px;padding:6px 14px;font-size:14px!important;color:${T.primary}}
[data-network-ui] .nw-option:hover,[data-network-ui] .nw-option:focus-visible{background:${T.muted};outline:none}
[data-network-ui] .nw-mark{display:grid;place-items:center;width:18px;height:18px;flex-shrink:0;border:1.5px solid ${T.input};border-radius:5px;color:${T.primaryFg}}
[data-network-ui] .nw-option[aria-checked="true"] .nw-mark{background:${T.primary};border-color:${T.primary}}
[data-network-ui] .nw-option-count{margin-left:auto;font-size:12px;color:${T.mutedFg};font-variant-numeric:tabular-nums}
[data-network-ui] .nw-menu-search{padding:8px 10px;border-bottom:1px solid ${T.border}}
[data-network-ui] .nw-menu-search .nw-input{height:38px}
[data-network-ui] .nw-menu-footer{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 12px;border-top:1px solid ${T.border};background:${T.muted}}
[data-network-ui] .nw-menu-footer button{font-size:13px!important;font-weight:700;color:${T.primary}}
[data-network-ui] .nw-status{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px;font-size:12px;color:${T.mutedFg}}
[data-network-ui] .nw-status button{font-size:12px!important;color:${T.mutedFg};padding:4px;border-radius:6px}
[data-network-ui] .nw-status button:hover{background:${T.muted};color:${T.primary}}
[data-network-ui] .nw-groups{margin-top:16px;display:flex;flex-direction:column;gap:24px}
[data-network-ui] .nw-group{scroll-margin-top:88px}
[data-network-ui] .nw-group-heading{display:flex;flex-wrap:wrap;align-items:center;gap:8px;width:100%;min-height:54px;padding:12px 16px;border-left:3px solid var(--nw-accent);background:var(--nw-tint)}
[data-network-ui] .nw-group-heading h2{font-family:${FONT.heading};font-size:16px;font-weight:700;color:${T.primary};margin:0}
[data-network-ui] .nw-group-heading small{font-size:12px;color:${T.mutedFg}}
[data-network-ui] .nw-chevron{margin-left:auto;font-size:12px;color:${T.mutedFg};transition:transform 150ms}
[data-network-ui] .nw-group-heading[aria-expanded="true"] .nw-chevron{transform:rotate(180deg)}
[data-network-ui] .nw-rows{background:${T.card};border-bottom:1px solid ${T.border};overflow:hidden}
[data-network-ui] .nw-row{display:flex;align-items:center;gap:16px;width:100%;padding:12px 16px;border-bottom:1px solid ${T.border};min-width:0}
[data-network-ui] button.nw-row:hover{background:color-mix(in oklab,${T.muted} 60%,${T.card})}
[data-network-ui] .nw-avatar{position:relative;display:flex;flex-shrink:0;align-items:center;justify-content:center;width:40px;height:40px;border-radius:999px;background:${T.goldSoft};color:${NET.accentFg};font-size:12px;font-weight:700}
[data-network-ui] .nw-avatar[data-org]{border-radius:8px;background:${T.sageSoft};color:${T.foreground}}
[data-network-ui] .nw-avatar i{position:absolute;right:-2px;bottom:-2px;width:12px;height:12px;border-radius:999px;box-shadow:0 0 0 2px ${T.card}}
[data-network-ui] .nw-main{min-width:0;flex:1}
[data-network-ui] .nw-line{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
[data-network-ui] .nw-name{font-family:${FONT.heading};font-size:15px;font-weight:700;color:${T.primary}}
[data-network-ui] .nw-type{--nw-c:${NET.unsure};display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:700;letter-spacing:.01em;white-space:nowrap;color:color-mix(in oklab,var(--nw-c) 62%,${T.primary})}
[data-network-ui] .nw-type::before{content:"";width:6px;height:6px;flex-shrink:0;border-radius:50%;background:var(--nw-c);box-shadow:0 0 0 2.5px color-mix(in oklab,var(--nw-c) 16%,transparent)}
[data-network-ui] .nw-quiet{font-size:12px;color:${T.mutedFg}}
[data-network-ui] .nw-sub{margin-top:4px;font-size:12px;line-height:1.6;color:${T.mutedFg}}
[data-network-ui] .nw-chips{display:inline-flex;min-width:0;flex-wrap:wrap;align-items:center;gap:4px;margin-top:4px}
[data-network-ui] .nw-chip{display:inline-flex;align-items:center;max-width:100%;padding:1px 8px;border-radius:999px;font-size:12px;line-height:18px;font-weight:700;white-space:nowrap;border:1px solid}
[data-network-ui] .nw-chip-more{color:${T.primary};background:${T.muted};border-color:${T.border}}
[data-network-ui] .nw-stats{display:flex;flex-direction:column;align-items:flex-end;gap:2px;width:192px;flex-shrink:0;text-align:right;font-size:12px}
[data-network-ui] .nw-stats-inline{display:none}
[data-network-ui] .nw-strong{font-family:${FONT.heading};font-weight:700;color:${T.primary}}
[data-network-ui] .nw-accent{color:${NET.accentFg}}
[data-network-ui] .nw-warn{color:${NET.warn}}
[data-network-ui] .nw-pager{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px;border-top:1px solid ${T.border};border-bottom:1px solid ${T.border};background:${T.card}}
[data-network-ui] .nw-pager-summary{display:flex;flex-wrap:wrap;align-items:center;gap:12px;font-size:12px;color:${T.mutedFg}}
[data-network-ui] .nw-pager select{min-height:44px;min-width:66px;border:1px solid ${T.input};border-radius:6px;background:${T.card};color:${T.primary};padding:0 8px;font-family:inherit;font-size:13px!important;margin-left:6px}
[data-network-ui] .nw-pager-nav{display:flex;align-items:center;justify-content:center;gap:2px}
[data-network-ui] .nw-pager-nav button{display:inline-grid;place-items:center;min-width:36px;min-height:44px;padding:0 6px;border-radius:10px;color:${T.mutedFg}}
[data-network-ui] .nw-pager-nav button:hover:not(:disabled){background:${T.muted};color:${T.primary}}
[data-network-ui] .nw-pager-pos{min-width:88px;text-align:center;font-size:12px;font-variant-numeric:tabular-nums;color:${T.primary}}
[data-network-ui] .nw-empty{padding:32px;border:1px dashed ${T.border};border-radius:14px;text-align:center;font-size:14px;color:${T.mutedFg};margin:0}
[data-network-ui] .nw-none{padding:16px;font-size:14px;color:${T.mutedFg};margin:0}
[data-network-ui] .nw-problem{margin-top:20px;padding:16px;border:1px solid ${NET.warn};border-radius:10px;background:${NET.warnSoft};color:${T.foreground};font-size:14px}
@media (max-width:767px){
  [data-network-ui] .nw-wrap{padding:16px 16px 40px}
  [data-network-ui] .nw-title{font-size:26px}
  [data-network-ui] .nw-toolbar{margin-top:16px}
  [data-network-ui] .nw-controls{flex-wrap:wrap;gap:8px}
  [data-network-ui] .nw-search{flex:1 1 100%}
  [data-network-ui] .nw-tags-anchor{flex:1 1 0;min-width:0}
  [data-network-ui] .nw-refine{flex-wrap:nowrap}
  [data-network-ui] .nw-pills{flex:1;min-width:0;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}
  [data-network-ui] .nw-pills::-webkit-scrollbar{display:none}
  [data-network-ui] .nw-pill{font-size:12.5px!important}
  [data-network-ui] .nw-row{gap:12px;align-items:flex-start}
  [data-network-ui] .nw-stats{display:none}
  [data-network-ui] .nw-stats-inline{display:flex;flex-wrap:wrap;gap:0 12px;margin-top:4px;font-size:12px}
  [data-network-ui] .nw-pager{justify-content:center}
}
@media (prefers-reduced-motion:reduce){[data-network-ui] *{animation:none!important;transition:none!important}}
`

const Svg = ({ children, size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
const IconSliders = () => <Svg><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" /></Svg>
const IconTag = () => <Svg><path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z" /><path d="M7 7h.01" /></Svg>
const IconCheck = () => <Svg size={12}><path d="M5 12l5 5l10 -10" /></Svg>
const IconPlus = () => <Svg><path d="M12 5v14M5 12h14" /></Svg>
const IconChevron = () => <Svg size={14}><path d="M6 9l6 6 6-6" /></Svg>
const IconMore = () => <Svg><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></Svg>
const IconDownload = () => <Svg><path d="M12 3v12M7 10l5 5 5-5M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /></Svg>
const IconClock = () => <Svg><path d="M8 2v4M16 2v4M3 10h18M21 13V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7" /><circle cx="18" cy="18" r="4" /><path d="M18 16.5V18l1 1" /></Svg>
const IconFirst = () => <Svg><path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" /></Svg>
const IconPrev = () => <Svg><path d="M15 18l-6-6 6-6" /></Svg>
const IconNext = () => <Svg><path d="M9 18l6-6-6-6" /></Svg>
const IconLast = () => <Svg><path d="M13 17l5-5-5-5M6 17l5-5-5-5" /></Svg>

/**
 * A small menu under its button. It closes on a click or tap ANYWHERE outside
 * it, on its trigger pressed again, on Escape, or on its own Done button.
 *
 * KEVIN'S RULING, 2026-11-19 (slice 6 feedback): "anywhere on the screen
 * should clear the prompt." That reverses, FOR THE NETWORK SCREENS ONLY, Bee
 * Hub's 2026-09-30 rule (75363e9: nothing closes on an outside click). Every
 * other menu in Bee Hub still follows the old rule until Kevin rules on them;
 * lib/beta-no-outside-close.test.tsx lets this one listener through by name.
 *
 * Closing from outside CANCELS: it only closes. It picks nothing in the menu
 * and changes no filter. (A filter box applies each tick as it is ticked, as
 * it always has, so what is already ticked stays ticked, exactly as with
 * Escape or Done.) The click itself carries on to whatever it landed on.
 * `children` is handed close(), for the Done button.
 */
function Menu({ trigger, children, className, anchorClass = '' }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const key = (e) => { if (e.key === 'Escape') setOpen(false) }
    // Pointer down, in the capture phase, so nothing on the page can swallow
    // it first. A press inside the anchor (the trigger or the menu) is left
    // to them: the trigger toggles, a choice closes the way it always has.
    const away = (e) => { if (anchor.current && !anchor.current.contains(e.target)) setOpen(false) }
    document.addEventListener('keydown', key)
    document.addEventListener('pointerdown', away, true) // network-menu-click-away (Kevin, 2026-11-19)
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', away, true) }
  }, [open])
  return (
    <div className={`nw-anchor ${anchorClass}`} ref={anchor}>
      {trigger(open, () => setOpen((v) => !v))}
      {open && <div className={`nw-menu ${className || ''}`} role="menu">{children(() => setOpen(false))}</div>}
    </div>
  )
}

function Option({ label, checked, onToggle, count, icon, testId }) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={checked} onClick={onToggle} className="nw-option" data-option={testId}>
      <span className="nw-mark">{checked && <IconCheck />}</span>
      {icon}
      <span style={{ flex: 1, textAlign: 'left' }}>{label}</span>
      {count !== undefined && <span className="nw-option-count">{count}</span>}
    </button>
  )
}

function Pager({ label, total, page, size, onPage, onSize }) {
  const pages = pageCount(total, size)
  const current = clampPage(page, total, size)
  const summary = total <= size
    ? `${total.toLocaleString()} ${total === 1 ? 'contact' : 'contacts'} total`
    : `${(current * size + 1).toLocaleString()}–${Math.min((current + 1) * size, total).toLocaleString()} of ${total.toLocaleString()} contacts`
  return (
    <nav className="nw-pager" aria-label={`${label} pagination`}>
      <div className="nw-pager-summary">
        <span role="status" data-pager-summary>{summary}</span>
        {onSize && (
          <label>Per page
            <select aria-label={`${label} per page`} value={size} onChange={(e) => onSize(Number(e.target.value))}>
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="nw-pager-nav">
        <button type="button" title="First page" aria-label={`${label} first page`} disabled={current === 0} onClick={() => onPage(0)}><IconFirst /></button>
        <button type="button" title="Previous page" aria-label={`${label} previous page`} disabled={current === 0} onClick={() => onPage(current - 1)}><IconPrev /></button>
        <span className="nw-pager-pos" aria-live="polite">Page {current + 1} of {pages.toLocaleString()}</span>
        <button type="button" title="Next page" aria-label={`${label} next page`} disabled={current >= pages - 1} onClick={() => onPage(current + 1)}><IconNext /></button>
        <button type="button" title="Last page" aria-label={`${label} last page`} disabled={current >= pages - 1} onClick={() => onPage(pages - 1)}><IconLast /></button>
      </div>
    </nav>
  )
}

// Two initials, from words that start with a letter or a digit ("Drew & Bill" is DB).
const initialsOf = (name) => String(name).replace(/—.*/, '').split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w)).slice(0, 2).map((w) => w[0]).join('').toUpperCase()

function Stats({ c, today, referralsKnown }) {
  const due = dueForFollowUp(c, today)
  const showReferrals = referralsKnown && (isReferralPartner(c) || c.referred > 0)
  // Nothing logged is unknown, not overdue: only a logged silence of 60 days
  // or more is painted as gone quiet.
  const quiet = c.lastTalkedDays !== null && c.lastTalkedDays >= COLD_AFTER_DAYS
  return (
    <>
      {showReferrals && (c.referred > 0
        ? <span className="nw-strong" data-referrals>{c.referred} {c.referred === 1 ? 'lead' : 'leads'} · {money(c.revenue)}</span>
        : <span className="nw-quiet" data-referrals>No referrals yet</span>)}
      {c.nextFollowUp
        ? <span className={due ? 'nw-accent' : 'nw-quiet'} data-follow-up={due ? 'due' : 'set'}>{due ? 'Follow-up due' : 'Follow-up'} {fixedDateLabel(c.nextFollowUp)}</span>
        : <span className={quiet ? 'nw-warn' : 'nw-quiet'}>{talkedLabel(c.lastTalkedDays)}</span>}
    </>
  )
}

function Row({ c, onOpen, today, showLocation, referralsKnown, even = false, selectable = false, selected = false, onSelect = null }) {
  const types = contactTypes(c)
  const org = isOrganization(c)
  const level = partnerLevel(c)
  const stage = partnerStage(c)
  const sub = [...(showLocation && c.locationName ? [c.locationName] : []), ...contactSecondaryDetails(c)]
  if (hasType(c, 'unsure') && c.howMet) sub.push(`Met: ${c.howMet}`)
  const body = (
    <>
      <span className="nw-avatar" data-org={org || undefined}>
        {org ? '🏢' : initialsOf(c.name)}
        <i style={{ background: TYPE_COLOR[types[0]] }} />
      </span>
      <span className="nw-main">
        <span className="nw-line">
          <span className="nw-name" data-name>{c.name}</span>
          {types.map((t) => <span key={t} className="nw-type" data-type={t} style={{ '--nw-c': TYPE_COLOR[t] }}>{TYPE_META[t].label}</span>)}
          {level && <span className="nw-quiet">Level: <span data-level={level}>{LEVEL_META[level].label}</span></span>}
          {stage && <span className="nw-quiet">· Stage: <span data-stage={stage}>{stage}</span></span>}
          {c.isCustomer && <span className="nw-quiet" data-also-client>· also a client</span>}
        </span>
        {sub.length > 0 && <span className="nw-sub" style={{ display: 'block' }}>{sub.join(' · ')}</span>}
        <span className="nw-stats-inline"><Stats c={c} today={today} referralsKnown={referralsKnown} /></span>
        {c.tags.length > 0 && (
          <span className="nw-chips" title={c.tags.join(', ')}>
            {c.tags.slice(0, 3).map((t) => { const tone = TAG_TONES[tagTone(t)]; return <span key={t} className="nw-chip" style={{ color: tone.fg, background: tone.bg, borderColor: tone.border }}>{t}</span> })}
            {c.tags.length > 3 && <span className="nw-chip nw-chip-more">+{c.tags.length - 3} more</span>}
          </span>
        )}
      </span>
      <span className="nw-stats"><Stats c={c} today={today} referralsKnown={referralsKnown} /></span>
    </>
  )
  return (
    <div className="nw-row-wrap" data-even={even || undefined} data-selected={selected || undefined}>
      {selectable && (
        <label className="nw-check"><input type="checkbox" checked={selected} onChange={(e) => onSelect(c.id, e.target.checked)} aria-label={`Select ${c.name}`} data-select={c.id} /></label>
      )}
      {onOpen
        ? <button type="button" className="nw-row" data-row={c.id} onClick={() => onOpen(c.id)} aria-label={`Open ${c.name}`}>{body}</button>
        : <div className="nw-row" data-row={c.id}>{body}</div>}
    </div>
  )
}

/**
 * The Referral partner group's one line about stages and levels. Nearly
 * everyone sits at one stage today, so that reads as a plain sentence, not as
 * a board of empty columns.
 */
export function stageLine(contacts) {
  const count = (pick, order) => order.map((k) => [k, contacts.filter((c) => pick(c) === k).length]).filter(([, n]) => n > 0)
  const stages = count(partnerStage, PARTNER_STAGES)
  const levels = count(partnerLevel, PARTNER_LEVELS).map(([k, n]) => [LEVEL_META[k].label, n])
  if (!contacts.length) return null
  const list = (xs) => xs.map(([k, n]) => `${k} ${n}`).join(' · ')
  return {
    stages: stages.length === 1 ? `All ${contacts.length} at ${stages[0][0]}` : list(stages),
    levels: levels.length === 1 ? `all ${levels[0][0]}` : list(levels),
  }
}

function Group({ type, contacts, open, onToggle, page, size, onPage, onSize, onOpen, today, showLocation, referralsKnown, selectable = false, selected = null, onSelect = null, onSelectMany = null }) {
  const top = useRef(null)
  const label = type ? TYPE_META[type].label : 'Network'
  const tone = toneOf(type)
  const shown = contactPage(contacts, page, size)
  const change = (p) => { onPage(p); if (top.current && top.current.scrollIntoView) top.current.scrollIntoView({ block: 'start' }) }
  return (
    <section ref={top} className="nw-group" data-group={type || 'all'} style={{ '--nw-accent': tone.accent, '--nw-tint': tone.tint }}>
      {type && (
        <button type="button" className="nw-group-heading" aria-expanded={open} onClick={onToggle}>
          <h2>{label}</h2>
          <small><b data-group-count style={{ fontWeight: 'inherit' }}>{contacts.length}</b> · {TYPE_META[type].blurb}</small>
          <span className="nw-chevron">▼</span>
        </button>
      )}
      {open && (
        <div className="nw-rows">
          <Pager label={label} total={contacts.length} page={page} size={size} onPage={change} onSize={onSize} />
          {type === 'partner' && (() => { const l = stageLine(contacts); return l && <p className="nw-stage-line" data-stage-line>Stage: <b>{l.stages}</b>. Level: <b>{l.levels}</b>.</p> })()}
          {contacts.length === 0 && <p className="nw-none">Nobody here yet.</p>}
          {selectable && shown.length > 0 && (() => {
            const all = shown.every((c) => selected.has(c.id))
            return <label className="nw-select-page"><input type="checkbox" checked={all} onChange={(e) => onSelectMany(shown.map((c) => c.id), e.target.checked)} data-select-page={type || 'all'} />{all ? `All ${shown.length} on this page picked` : `Pick all ${shown.length} on this page`}</label>
          })()}
          {shown.map((c, i) => <Row key={c.id} c={c} onOpen={onOpen} today={today} showLocation={showLocation} referralsKnown={referralsKnown} even={i % 2 === 1}
            selectable={selectable} selected={!!selected?.has(c.id)} onSelect={onSelect} />)}
          {contacts.length > size && <Pager label={label} total={contacts.length} page={page} size={size} onPage={change} />}
        </div>
      )}
    </section>
  )
}

/**
 * Props
 *   locationId        a location's id, or null for every location
 *   locationName      shown in the heading when one location is picked
 *   onOpenContact     (id) => void. Omit it and rows are not buttons: the
 *                     every-location view passes none, because the existing
 *                     record can only be opened inside one location.
 *   refreshKey        change it to read the list again (the host does, after a
 *                     save in the contact sheet)
 *   initialTagId      a tag to start filtered by (Search's "All N tagged X in Network")
 *   onInitialTagConsumed
 *   fetchImpl, now    for tests
 */
export default function NetworkListScreen({
  locationId = null, locationName = '', onOpenContact = null,
  initialTagId = null, onInitialTagConsumed = () => {}, fetchImpl = null, now = null, refreshKey = 0,
}) {
  const [data, setData] = useState(null)        // { contacts, tags, followUps, truncated }
  const [referrals, setReferrals] = useState(null) // Map id → rollup, or null until it answers
  const [problem, setProblem] = useState('')
  const [f, setF] = useState(NO_FILTERS)
  const [openGroups, setOpenGroups] = useState({})
  const [pages, setPages] = useState({})
  const [size, setSize] = useState(25)
  const [tagSearch, setTagSearch] = useState('')
  // Slice 5: adding, importing, exporting. Only ever inside one location.
  const [dialog, setDialog] = useState(null) // null | 'add' | 'import'
  const [reloads, setReloads] = useState(0)
  const [actNote, setActNote] = useState(null) // { words, tone }
  // Slice 6: bulk selection (ids), the action waiting for its one yes, and
  // this location's Network tags for the bulk tag pickers.
  const [selected, setSelected] = useState(() => new Set())
  const [bulk, setBulk] = useState(null) // { action, value, label } waiting to be confirmed
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkError, setBulkError] = useState(null)
  const [locTags, setLocTags] = useState(null)

  const nowMs = useMemo(() => (now ? now.getTime() : Date.now()), [now])
  const today = useMemo(() => new Date(nowMs).toLocaleDateString('en-CA'), [nowMs])

  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia) setSize(defaultPageSize(window.matchMedia('(max-width: 767px)').matches))
  }, [])

  useEffect(() => {
    let alive = true
    const doFetch = fetchImpl || fetch
    const qs = locationId ? `?location_id=${encodeURIComponent(locationId)}` : ''
    setData(null); setReferrals(null); setProblem('')
    doFetch(`/api/network/list${qs}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
        if (alive) setData(json)
      })
      .catch((e) => { if (alive) setProblem(String(e?.message || e)) })
    // Referral numbers are a second, independent read. Until it answers the
    // rows show no referral line at all: never a made-up zero.
    doFetch(`/api/network/summary${qs}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}))
        if (!res.ok || !alive) return
        setReferrals(new Map((json.referrers || []).filter((r) => r.kind === 'partner').map((r) => [r.id, r])))
      })
      .catch(() => {})
    return () => { alive = false }
  }, [locationId, fetchImpl, refreshKey, reloads])

  // A new location (or a reload) starts with nothing picked.
  useEffect(() => { setSelected(new Set()); setBulk(null) }, [locationId, refreshKey, reloads])
  // This location's Network tags, for the bulk tag pickers.
  useEffect(() => {
    if (!locationId) { setLocTags(null); return undefined }
    let alive = true
    const doFetch = fetchImpl || fetch
    doFetch(`/api/lookups?category=tags&location_id=${encodeURIComponent(locationId)}`)
      .then(async (res) => { const json = await res.json().catch(() => ({})); if (alive) setLocTags(res.ok && Array.isArray(json.lookups) ? networkTagsFor(json.lookups, locationId).sort((a, b) => String(a.label).localeCompare(String(b.label))) : []) })
      .catch(() => { if (alive) setLocTags([]) })
    return () => { alive = false }
  }, [locationId, fetchImpl])

  // A tag handed in from Search: start filtered by it, once.
  useEffect(() => {
    if (!initialTagId) return
    setF({ ...NO_FILTERS, tagIds: [initialTagId] })
    onInitialTagConsumed()
  }, [initialTagId]) // eslint-disable-line react-hooks/exhaustive-deps

  const tagLabel = useMemo(() => {
    const m = new Map((data?.tags || []).map((t) => [t.id, t.label]))
    return (id) => m.get(id)
  }, [data])

  const contacts = useMemo(() => (data?.contacts || []).map((row) => contactFromRow(row, {
    tagLabel, nextFollowUp: data?.followUps?.[row.id], referral: referrals?.get(row.id), nowMs,
  })), [data, referrals, tagLabel, nowMs])

  const counts = useMemo(() => typeCounts(contacts), [contacts])
  const tags = useMemo(() => tagsInUse(contacts, tagLabel), [contacts, tagLabel])
  const filtered = useMemo(() => applyListFilters(contacts, f, today), [contacts, f, today])
  const groups = useMemo(() => groupForList(filtered, f), [filtered, f])
  const firstGroup = groups.find((g) => g.contacts.length)?.type ?? groups[0]?.type ?? null
  const followUpCount = useMemo(() => contacts.filter((c) => dueForFollowUp(c, today)).length, [contacts, today])

  // Any change to what is listed starts every group back on its first page.
  const set = (patch) => { setF((prev) => ({ ...prev, ...patch })); setPages({}) }
  const flip = (key, value) => set({ [key]: f[key].includes(value) ? f[key].filter((x) => x !== value) : [...f[key], value] })
  const clearMenu = () => set({ levels: [], stages: [], followUp: false })
  const menuCount = menuFilterCount(f)
  const shownTags = tags.filter((t) => t.label.toLowerCase().includes(tagSearch.trim().toLowerCase()))

  // ── Bulk (slice 6) ─────────────────────────────────────────
  const selectable = !!locationId
  // In name order, as the list shows them.
  const pickedContacts = contacts.filter((c) => selected.has(c.id)).sort((a, b) => a.name.localeCompare(b.name))
  const pickedPartners = pickedContacts.filter((c) => isReferralPartner(c))
  const onSelect = (id, on) => setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n })
  const onSelectMany = (ids, on) => setSelected((s) => { const n = new Set(s); for (const id of ids) { if (on) n.add(id); else n.delete(id) } return n })
  const askBulk = (action, value) => {
    if (!value) return
    const label = action === 'level' ? LEVEL_META[value].label : action === 'stage' ? value : (locTags || []).find((t) => t.id === value)?.label || 'that tag'
    setBulk({ action, value, label }); setBulkError(null)
  }
  // What the one confirmation says, worked out from the list as it is shown.
  const bulkSummary = useMemo(() => {
    if (!bulk) return null
    const n = pickedContacts.length
    const people = (k) => `${k} ${k === 1 ? 'contact' : 'contacts'}`
    if (bulk.action === 'level' || bulk.action === 'stage') {
      const now = (c) => (bulk.action === 'level' ? partnerLevel(c) : partnerStage(c))
      const notPartner = n - pickedPartners.length
      const already = pickedPartners.filter((c) => now(c) === bulk.value).length
      const moving = pickedPartners.length - already
      return {
        title: `${bulkActionWords(bulk.action, bulk.label)}: ${people(moving)}?`,
        names: pickedPartners.filter((c) => now(c) !== bulk.value).slice(0, 5).map((c) => c.name).concat(moving > 5 ? [`and ${moving - 5} more`] : []),
        warn: [notPartner ? `${people(notPartner)} ${notPartner === 1 ? 'isn’t a Referral partner' : 'aren’t Referral partners'}, so ${notPartner === 1 ? 'it is' : 'they are'} left as they are.` : '', already ? `${already} already ${already === 1 ? 'is' : 'are'} there.` : ''].filter(Boolean).join(' ') || null,
        moving,
      }
    }
    const has = (c) => c.tagIds.includes(bulk.value)
    const moving = pickedContacts.filter((c) => (bulk.action === 'tag_add' ? !has(c) : has(c))).length
    return {
      title: `${bulkActionWords(bulk.action, bulk.label)} ${bulk.action === 'tag_add' ? 'on' : 'from'} ${people(moving)}?`,
      names: pickedContacts.filter((c) => (bulk.action === 'tag_add' ? !has(c) : has(c))).slice(0, 5).map((c) => c.name).concat(moving > 5 ? [`and ${moving - 5} more`] : []),
      warn: n - moving ? `${people(n - moving)} ${bulk.action === 'tag_add' ? 'already' : 'don’t'} have it, so ${n - moving === 1 ? 'it is' : 'they are'} left as they are.` : null,
      moving,
    }
  }, [bulk, pickedContacts, pickedPartners])

  async function confirmBulk() {
    if (!bulk || bulkBusy) return
    setBulkBusy(true); setBulkError(null)
    try {
      const doFetch = fetchImpl || fetch
      const res = await doFetch('/api/network/contacts/bulk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, ids: [...selected], action: bulk.action, value: bulk.value, confirmed: true }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) {
        setBulkError(BULK_ERROR_WORDS[json?.error] || 'That did not save. Nothing was changed. Check the connection and try again.')
        if (json?.error === 'contact_not_found') setReloads((x) => x + 1)
        return
      }
      const left = (json.unchanged || 0) + (json.skipped?.length || 0)
      setActNote({ words: `${bulkActionWords(bulk.action, bulk.label)}: ${json.changed} changed.${left ? ` ${left} left as ${left === 1 ? 'it was' : 'they were'}.` : ''}`, tone: 'good' })
      setBulk(null)
      setReloads((x) => x + 1)
    } catch {
      setBulkError('That did not save. Nothing was changed. Check the connection and try again.')
    } finally {
      setBulkBusy(false)
    }
  }

  // EXPORT: every contact at THIS location, whatever the filters show, in the
  // columns the import reads (lib/network/csv.ts). On All Locations there is
  // no export: one file across every location is not offered.
  const exportAll = () => {
    if (!locationId || !contacts.length) return
    const name = exportFileName(locationName, new Date(nowMs))
    // Referral numbers come from a second read. Until it has answered, those
    // two columns are left blank: never a made-up zero (slice 3's rule).
    downloadText(name, exportText(referrals ? contacts : contacts.map((c) => ({ ...c, referred: '', converted: '' }))))
    setActNote({ words: `Saved ${name}: ${contacts.length} contact${contacts.length === 1 ? '' : 's'} at ${locationName || 'this location'}.`, tone: 'good' })
  }

  return (
    <div data-network-ui data-network-list>
      <link rel="stylesheet" href={FONT_STYLESHEET_HREF} />
      <style>{CSS}</style>
      <div className="nw-wrap" data-bulk-open={(selectable && selected.size > 0) || undefined}>
        <p className="nw-eyebrow">Network &amp; Nurture</p>
        <h1 className="nw-title">Network{locationId && locationName ? ` · ${locationName}` : ''}</h1>
        <p className="nw-lede">Everyone who isn&rsquo;t a client: who sends you work, who you recommend, and who you are still figuring out.</p>
        <span className="nw-preview" data-preview-note>Preview. Only super admins can see this; owners still see Network closed.</span>

        <div className="nw-actions" data-actions>
          {/* ONE BUTTON for adding (2026-11-19): one person, or from a
              spreadsheet. It is the list's own Menu: it closes by picking a
              choice, pressing the button again, Escape, or a click anywhere
              outside it (Kevin, 2026-11-19). */}
          <Menu anchorClass="nw-add-anchor" className="nw-add-menu" trigger={(open, toggle) => (
            <button type="button" className="nw-act" data-primary disabled={!locationId} aria-expanded={open} aria-haspopup="menu" onClick={toggle} data-act="add-contacts">
              <IconPlus />Add contacts<IconChevron />
            </button>
          )}>{(close) => (<>
            <button type="button" role="menuitem" className="nw-add-choice" onClick={() => { close(); setActNote(null); setDialog('add') }} data-act="add">
              <b>One person</b><span>Type in someone you met, or an organization.</span>
            </button>
            <button type="button" role="menuitem" className="nw-add-choice" onClick={() => { close(); setActNote(null); setDialog('import') }} data-act="import">
              <b>From a spreadsheet</b><span>A CSV file from Outlook, Google Contacts, Mailchimp, LinkedIn or any spreadsheet.</span>
            </button>
          </>)}</Menu>
          {/* MORE: the rare actions. Export only, for now. */}
          <Menu anchorClass="nw-more-anchor" className="nw-more-menu" trigger={(open, toggle) => (
            <button type="button" className="nw-act" aria-expanded={open} aria-haspopup="menu" onClick={toggle} aria-label="More" data-act="more"><IconMore />More</button>
          )}>{(close) => (<>
            <button type="button" role="menuitem" className="nw-add-choice" disabled={!locationId || !data || !contacts.length} onClick={() => { close(); exportAll() }} data-act="export">
              <b><IconDownload /> Export CSV</b><span>{locationId ? (data ? `All ${contacts.length} at ${locationName || 'this location'}, in the columns the import reads.` : 'Loading…') : 'Pick one location first.'}</span>
            </button>
          </>)}</Menu>
          {!locationId && <p className="nw-act-note" data-act-note="pick-location">Pick one location to add, change or export contacts. A contact belongs to one location, so none of these work across all of them at once.</p>}
          {locationId && actNote && <p className="nw-act-note" data-tone={actNote.tone} role="status" data-act-note="done">{actNote.words}</p>}
        </div>

        {problem && <div className="nw-problem" role="alert" data-problem>We couldn&rsquo;t load the Network list ({problem}). Nothing has been changed. Reload the page to try again.</div>}
        {!problem && !data && <p className="nw-none" data-loading style={{ marginTop: '20px' }}>Loading contacts…</p>}

        {data && (
          <>
            <div className="nw-toolbar">
              <div className="nw-controls">
                <div className="nw-search">
                  <input className="nw-input" type="search" enterKeyHint="search" value={f.q} onChange={(e) => set({ q: e.target.value })}
                    placeholder="Search name, company, email or phone…" aria-label="Search network" data-search />
                </div>
                <Menu anchorClass="nw-tags-anchor" trigger={(open, toggle) => (
                  <button type="button" className="nw-trigger" aria-expanded={open} onClick={toggle} data-active={f.tagIds.length > 0 || undefined}
                    aria-label={f.tagIds.length ? `Tags, ${f.tagIds.length} picked` : 'Tags'} data-tags-trigger>
                    <IconTag />Tags{f.tagIds.length > 0 && <span className="nw-trigger-count">{f.tagIds.length}</span>}
                  </button>
                )}>{(close) => (<>
                  <div className="nw-menu-search"><input className="nw-input" type="search" value={tagSearch} onChange={(e) => setTagSearch(e.target.value)} placeholder="Find a tag…" aria-label="Find a tag" /></div>
                  <div className="nw-menu-body">
                    {shownTags.length === 0 && <p className="nw-none">{tags.length ? 'No tag by that name.' : 'Nobody here has a tag yet.'}</p>}
                    {shownTags.map((t) => <Option key={t.id} testId={`tag-${t.id}`} label={t.label} count={t.count} checked={f.tagIds.includes(t.id)} onToggle={() => flip('tagIds', t.id)} />)}
                  </div>
                  <div className="nw-menu-footer"><button type="button" onClick={() => set({ tagIds: [] })} disabled={!f.tagIds.length}>Clear all</button><button type="button" onClick={close} data-menu-done>Done</button></div>
                </>)}</Menu>
              </div>

              <div className="nw-refine">
                <div className="nw-pills" role="tablist" aria-label="Contact type">
                  {['all', ...NET_TYPES].map((t) => (
                    <button type="button" key={t} role="tab" aria-selected={f.type === t} className="nw-pill" data-type-pill={t} onClick={() => set({ type: t })}>
                      {t === 'all' ? 'Everyone' : TYPE_META[t].label}<span data-count>{counts[t]}</span>
                    </button>
                  ))}
                </div>
                <div className="nw-menu-row">
                  <Menu trigger={(open, toggle) => (
                    <button type="button" className="nw-trigger" aria-expanded={open} onClick={toggle} data-active={menuCount > 0 || undefined}
                      aria-label={menuCount ? `Filters, ${menuCount} on` : 'Filters'} data-filters-trigger>
                      <IconSliders />Filters{menuCount > 0 && <span className="nw-trigger-count">{menuCount}</span>}
                    </button>
                  )}>{(close) => (<>
                    <div className="nw-menu-body">
                      <div className="nw-menu-section" role="group" aria-label="Partner level">
                        <p className="nw-menu-title">Partner level</p>
                        {PARTNER_LEVELS.map((l) => <Option key={l} testId={`level-${l}`} label={LEVEL_META[l].label} checked={f.levels.includes(l)} onToggle={() => flip('levels', l)} />)}
                      </div>
                      <div className="nw-menu-section" role="group" aria-label="Partner stage">
                        <p className="nw-menu-title">Partner stage</p>
                        {PARTNER_STAGES.map((s) => <Option key={s} testId={`stage-${s}`} label={s} checked={f.stages.includes(s)} onToggle={() => flip('stages', s)} />)}
                      </div>
                      <div className="nw-menu-section" role="group" aria-label="Care">
                        <p className="nw-menu-title">Care</p>
                        <Option testId="follow-up" label="Needs follow-up" count={followUpCount} icon={<span style={{ color: T.mutedFg, display: 'inline-flex' }}><IconClock /></span>} checked={f.followUp} onToggle={() => set({ followUp: !f.followUp })} />
                      </div>
                    </div>
                    <div className="nw-menu-footer"><button type="button" onClick={clearMenu} disabled={!menuCount}>Clear all</button><button type="button" onClick={close} data-menu-done>Done</button></div>
                  </>)}</Menu>
                </div>
              </div>

              {anyFilterOn(f) && (
                <div className="nw-status">
                  <span role="status" data-matching>{filtered.length.toLocaleString()} matching {filtered.length === 1 ? 'contact' : 'contacts'}</span>
                  <button type="button" onClick={() => { setF(NO_FILTERS); setPages({}); setTagSearch('') }} data-clear-filters>Clear filters</button>
                </div>
              )}
              {data.truncated && <div className="nw-problem" data-truncated>This list is cut short at {data.total.toLocaleString()} contacts. The counts above are not the whole network.</div>}
              {!onOpenContact && contacts.length > 0 && <p className="nw-quiet" data-open-hint style={{ margin: '8px 0 0' }}>Pick one location to open a contact.</p>}
            </div>

            <div className="nw-groups">
              {groups.map((g) => {
                const key = g.type || 'all'
                const open = g.type ? (openGroups[key] ?? g.type === firstGroup) : true
                return (
                  <Group key={key} type={g.type} contacts={g.contacts} open={open}
                    onToggle={() => setOpenGroups((m) => ({ ...m, [key]: !open }))}
                    page={pages[key] || 0} size={size}
                    onPage={(p) => setPages((m) => ({ ...m, [key]: p }))}
                    onSize={(n) => { setSize(n); setPages({}) }}
                    onOpen={onOpenContact} today={today} showLocation={!locationId} referralsKnown={!!referrals}
                    selectable={selectable} selected={selected} onSelect={onSelect} onSelectMany={onSelectMany} />
                )
              })}
              {filtered.length === 0 && (
                <p className="nw-empty" data-empty>{contacts.length === 0 ? 'Nobody in this network yet.' : 'Nobody matches those filters.'}</p>
              )}
            </div>

            {/* THE BULK BAR is pinned to the bottom of the window, but it is
                drawn inside the CONTENT AREA, not the whole window: on a
                desktop Bee Hub's left menu (192px, or 80 folded, set as
                --bee-rail-w by BeeHub.jsx, drawn on top) covers the window's
                left edge. Slice 6 centred it on the whole window, so its left
                end sat under that menu (Kevin, on the preview). Now its edges
                are the list's own edges: 32px in from the content area, 16px
                on a phone, never wider than the list. */}
            {selectable && selected.size > 0 && (
              <div className="nw-bulk" role="region" aria-label="Change the picked contacts" data-bulk-bar>
                <b data-bulk-count>{selected.size} picked</b>
                <select value="" onChange={(e) => askBulk('tag_add', e.target.value)} disabled={!locTags || !locTags.length} aria-label="Add a tag to the picked contacts" data-bulk="tag_add">
                  <option value="">Add a tag…</option>
                  {(locTags || []).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
                <select value="" onChange={(e) => askBulk('tag_remove', e.target.value)} disabled={!locTags || !locTags.length} aria-label="Take a tag off the picked contacts" data-bulk="tag_remove">
                  <option value="">Take off a tag…</option>
                  {(locTags || []).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
                <select value="" onChange={(e) => askBulk('level', e.target.value)} disabled={!pickedPartners.length} aria-label="Set the level of the picked Referral partners" data-bulk="level"
                  title={pickedPartners.length ? undefined : 'Only a Referral partner has a level'}>
                  <option value="">{pickedPartners.length ? 'Set level…' : 'Level: Referral partners only'}</option>
                  {PARTNER_LEVELS.map((l) => <option key={l} value={l}>{LEVEL_META[l].label}</option>)}
                </select>
                <select value="" onChange={(e) => askBulk('stage', e.target.value)} disabled={!pickedPartners.length} aria-label="Set the stage of the picked Referral partners" data-bulk="stage"
                  title={pickedPartners.length ? undefined : 'Only a Referral partner has a stage'}>
                  <option value="">{pickedPartners.length ? 'Set stage…' : 'Stage: Referral partners only'}</option>
                  {PARTNER_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <button type="button" onClick={() => setSelected(new Set())} data-bulk-clear>Clear</button>
              </div>
            )}
          </>
        )}
      </div>
      {bulk && bulkSummary && (
        <ConfirmChange title={bulkSummary.title} names={bulkSummary.names} warn={bulkSummary.warn}
          detail={bulkSummary.moving === 0 ? 'Nothing would change.' : null}
          confirmLabel={bulkSummary.moving === 0 ? 'OK' : 'Yes, change them'} busy={bulkBusy} error={bulkError}
          onConfirm={() => { if (bulkSummary.moving === 0) setBulk(null); else confirmBulk() }}
          onCancel={() => { if (!bulkBusy) { setBulk(null); setBulkError(null) } }} />
      )}
      {dialog === 'add' && locationId && (
        <AddContactDialog locationId={locationId} locationName={locationName} fetchImpl={fetchImpl}
          onClose={() => setDialog(null)}
          onAdded={(id) => { setDialog(null); setReloads((n) => n + 1); if (onOpenContact) onOpenContact(id) }}
          onOpenExisting={onOpenContact ? (id) => { setDialog(null); onOpenContact(id) } : null} />
      )}
      {dialog === 'import' && locationId && (
        <ImportDialog locationId={locationId} locationName={locationName} fetchImpl={fetchImpl}
          onClose={() => setDialog(null)}
          onImported={() => setReloads((n) => n + 1)} />
      )}
    </div>
  )
}
