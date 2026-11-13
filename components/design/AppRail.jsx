// components/design/AppRail.jsx
// ─────────────────────────────────────────────────────────────
// THE LEFT MENU — the frame around every screen in Bee Hub, rebuilt to the
// designer's export (2026-11-13: src/components/settings/AppRail.tsx in the
// Lovable export). The first rebuilt piece OUTSIDE Settings.
//
// Same pattern as the Settings rebuild: the export is Tailwind + Radix +
// lucide and none of that is used. Its layout, spacing, wording and colours
// are redrawn here as inline styles from components/design/tokens.js, with
// inline-SVG icons. No dependency was added.
//
// This file DRAWS the menu. It decides nothing:
//   · WHICH items exist, and for whom (Admin only for corporate and super
//     admin; the onboarding lock), is `navItems` in BeeHub.jsx, unchanged.
//   · WHERE an item goes is BeeHub's nav().
//   · WHICH items are closed is BeeHub's CLOSED_NAV. A closed item arrives
//     here as `soon: true` and is drawn the way Settings draws Tags and Text
//     messaging: at half strength, with its note, as a plain <div> — not a
//     button, nothing to click, nothing to tab to.
//
// FROM THE EXPORT: 192px wide (was 220), which lines up with the Settings
// column; a collapse control down to an 80px icon strip; a box that filters
// the menu; the phone drawer (same menu, slides in, tap outside to close);
// the honeycomb behind the header; "Network & Nurture".
//
// NOT FROM THE EXPORT, each on purpose:
//   · In the export every item but Settings is disabled, because the
//     prototype contains nothing but Settings ("not included in this
//     Settings design"). Here Home, Reminders, Clients, Settings, Help and
//     Admin are LIVE (Kevin's ruling); only the three `soon` items are not.
//   · The export has no "Ask Bee Hub" and no global search. Both are KEPT:
//     on a desktop this menu is the only way to open Ask Bee Hub — and the
//     Quick Start Guide and the Manual open from it — and the Search button
//     is the visible way into finding a client. Dropping either would
//     strand a screen.
//   · The export's footer is a name and nothing else. Bee Hub's is the
//     identity control (who you are, view-as, the location switcher, sign
//     out), handed in as `footer` and kept whole.
//   · THE LOGO. The export shows the Bee Organized logo, but the zip holds
//     only a pointer to a file Lovable hosts. Until Kevin supplies the file
//     the bee that was there stays (`brandMark`); nothing is drawn in its
//     place. To use the real logo: hand an <img> in as `brandMark`.
//
// FONT. The menu is a rebuilt piece, so it takes the new look's font — only
// on itself ([data-app-rail]); no screen it frames changes font. It renders
// the one web-font <link> with itself, the way a rebuilt Settings page does.
// ─────────────────────────────────────────────────────────────
'use client'

import React from 'react'
import { T, R, FONT, FONT_STYLESHEET_HREF, alpha } from '@/components/design/tokens'

export const RAIL_W = 192
export const RAIL_W_COLLAPSED = 80
export const RAIL_COLLAPSED_KEY = 'bee_menu_collapsed'

// ── Icons: inline SVG, 24×24, 2px stroke, currentColor. No icon package. ──
const draw = (children) => function Icon({ size = 18, style = {} }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, display: 'block', ...style }}>
      {children}
    </svg>
  )
}
const ICONS = {
  home: draw(<><path d="M5 12H3l9 -9l9 9h-2" /><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7" /><path d="M9 21v-6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v6" /></>),
  reminders: draw(<><path d="M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3H4a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6" /><path d="M9 17v1a3 3 0 0 0 6 0v-1" /></>),
  hive: draw(<><circle cx="9" cy="7" r="4" /><path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /><path d="M21 21v-2a4 4 0 0 0 -3 -3.85" /></>),
  partners: draw(<><rect x="9" y="3" width="6" height="5" rx="1" /><rect x="3" y="16" width="6" height="5" rx="1" /><rect x="15" y="16" width="6" height="5" rx="1" /><path d="M12 8v4" /><path d="M6 16v-2a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v2" /></>),
  reports: draw(<><path d="M4 20V4" /><path d="M4 20h16" /><rect x="7" y="12" width="3" height="5" /><rect x="12" y="8" width="3" height="9" /><rect x="17" y="5" width="3" height="12" /></>),
  backoffice: draw(<><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2 -2h4a2 2 0 0 1 2 2v2" /><path d="M12 12v.01" /><path d="M3 13a20 20 0 0 0 18 0" /></>),
  settings: draw(<><path d="M20 7h-9" /><path d="M14 17H5" /><circle cx="17" cy="17" r="3" /><circle cx="7" cy="7" r="3" /></>),
  help: draw(<><circle cx="12" cy="12" r="9" /><path d="M12 17v.01" /><path d="M12 13.5a1.5 1.5 0 0 1 1 -1.5a2.6 2.6 0 1 0 -3 -4" /></>),
  admin: draw(<><path d="M3 21h18" /><path d="M5 21V7l8 -4v18" /><path d="M19 21V11l-6 -4" /><path d="M9 9v.01" /><path d="M9 12v.01" /><path d="M9 15v.01" /><path d="M9 18v.01" /></>),
}
const IconSearch = draw(<><circle cx="10" cy="10" r="7" /><path d="M21 21l-6 -6" /></>)
const IconX = draw(<><path d="M18 6L6 18" /><path d="M6 6l12 12" /></>)
const IconCollapse = draw(<><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 4v16" /><path d="M15 10l-2 2l2 2" /></>)
const IconExpand = draw(<><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 4v16" /><path d="M14 10l2 2l-2 2" /></>)
const iconFor = key => ICONS[key] || ICONS.settings

// The export's honeycomb, in the shared gold, behind the header.
const RAIL_HONEYCOMB = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='42' height='72' viewBox='0 0 42 72'><path d='M21 1L41 12v24L21 48L1 36V12ZM1 36L21 48v24M41 36L21 48' fill='none' stroke='${T.gold}' stroke-opacity='0.35' stroke-width='.6'/></svg>`)}")`

// What inline styles cannot say. Every selector starts with [data-app-rail],
// so nothing outside the menu can match. (The font-size rule is there
// because app/globals.css forces 16px onto every input.)
export const APP_RAIL_CSS = `
[data-app-rail]{-webkit-tap-highlight-color:transparent}
[data-app-rail] :is(button,input,a,[tabindex]):focus-visible{outline:none!important;box-shadow:0 0 0 2px ${T.gold}!important}
[data-app-rail] [data-rail-item]:not([data-active]):not(:disabled):hover{background-color:${alpha(T.railFg, 0.05)}!important;color:${T.railFg}!important}
[data-app-rail] [data-rail-quiet]:hover{background-color:${alpha(T.railFg, 0.08)}!important;color:${T.railFg}!important}
[data-app-rail] input[data-rail-filter]{font-size:14px!important}
[data-app-rail] input[data-rail-filter]::placeholder{color:${T.railMuted}}
@keyframes bee-rail-drawer-in{from{transform:translateX(-100%)}to{transform:translateX(0)}}
@keyframes bee-rail-overlay-in{from{opacity:0}to{opacity:1}}
[data-app-rail][data-rail-drawer]{animation:bee-rail-drawer-in .25s ease-out}
[data-rail-overlay]{animation:bee-rail-overlay-in .2s ease-out}
@media (prefers-reduced-motion:reduce){[data-app-rail][data-rail-drawer],[data-rail-overlay]{animation:none}}
`

const rowBase = { display:'flex', alignItems:'center', width:'100%', minHeight:'44px', boxSizing:'border-box', borderRadius:R.md, border:'1px solid transparent', background:'transparent', fontFamily:'inherit', textAlign:'left', color:T.railMuted, transition:'background-color .18s, color .18s' }

// ── One row ───────────────────────────────────────────────────────────────
// item: { key, label, badge?, locked?, soon?, note? }
//   soon    closed (BeeHub's CLOSED_NAV): a <div>, greyed, never a button
//   locked  the onboarding lock that was already there: dimmed, does nothing
function RailItem({ item, active, compact, onPick, Badge }) {
  const Icon = iconFor(item.key)
  const pad = compact ? { justifyContent:'center', padding:'8px 0' } : { justifyContent:'flex-start', gap:'10px', padding:'8px 10px' }
  const label = (
    <span style={{ minWidth:0, flex:1, fontSize:'13px', lineHeight:'16px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{item.label}</span>
  )

  // CLOSED. The treatment Settings gives Tags and Text messaging: the name
  // at half strength, its note readable, and not a control of any kind.
  if (item.soon) {
    return (
      <div data-rail-item data-nav={item.key} data-soon="" aria-disabled="true"
        title={item.note ? `${item.label} — ${item.note.toLowerCase()}` : `${item.label} — not available yet`}
        style={{ ...rowBase, ...pad, cursor:'default' }}>
        <span aria-hidden="true" style={{ display:'flex', opacity:0.4 }}><Icon /></span>
        {!compact && (
          <span style={{ minWidth:0, flex:1 }}>
            <span style={{ display:'block', fontSize:'13px', lineHeight:'16px', whiteSpace:'nowrap', opacity:0.5 }}>{item.label}</span>
            {item.note && <span data-soon-chip style={{ display:'block', marginTop:'3px', fontSize:'9px', lineHeight:'12px', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.12em', whiteSpace:'nowrap', color:T.railMuted }}>{item.note}</span>}
          </span>
        )}
      </div>
    )
  }

  return (
    <button type="button" data-rail-item data-nav={item.key} data-active={active ? '' : undefined} data-locked={item.locked ? '' : undefined}
      aria-current={active ? 'page' : undefined} aria-label={compact ? item.label : undefined} title={compact ? item.label : undefined}
      onClick={() => { if (!item.locked) onPick(item.key) }}
      style={{ ...rowBase, ...pad, cursor: item.locked ? 'default' : 'pointer', opacity: item.locked ? 0.3 : 1,
        ...(active ? { background:alpha(T.gold, 0.1), borderColor:alpha(T.gold, 0.2), boxShadow:`inset 3px 0 ${T.gold}`, color:T.railFg, fontWeight:700 } : null) }}>
      <span aria-hidden="true" style={{ display:'flex', position:'relative', color: active ? T.gold : 'inherit' }}>
        <Icon />
        {/* On the icon strip there is no room beside the name, so a count rides the icon. */}
        {compact && item.badge > 0 && <span data-rail-dot style={{ position:'absolute', top:'-3px', right:'-4px', width:'8px', height:'8px', borderRadius:R.full, background:T.gold }} />}
      </span>
      {!compact && label}
      {!compact && Badge && <Badge count={item.badge} />}
      {!compact && active && <span aria-hidden="true" style={{ marginLeft: item.badge > 0 ? '6px' : 'auto', width:'6px', height:'6px', flexShrink:0, borderRadius:R.full, background:T.gold }} />}
    </button>
  )
}

// ── The inside of the menu, for the desktop column and the phone drawer ───
function RailBody({ compact, mobile, items, lower, active, onPick, onClose, brandMark, ask, onSearch, footer, mobileFooter, account, Badge, onToggle }) {
  const [query, setQuery] = React.useState('')
  const matches = (it) => compact || it.label.toLowerCase().includes(query.trim().toLowerCase())
  const shown = items.filter(matches), shownLower = lower.filter(matches)
  const pick = (key) => { onPick(key); if (mobile && onClose) onClose() }
  const line = `1px solid ${alpha(T.railFg, 0.1)}`
  const quiet = { display:'flex', alignItems:'center', width:'100%', minHeight:'44px', boxSizing:'border-box', borderRadius:R.md, border:'none', background:'transparent', color:T.railMuted, cursor:'pointer', fontFamily:'inherit', transition:'background-color .18s, color .18s' }

  return <>
    <header style={{ position:'relative', flexShrink:0, borderBottom:line, padding: compact ? '24px 12px' : '24px 16px 20px' }}>
      <div aria-hidden="true" style={{ position:'absolute', inset:0, pointerEvents:'none', backgroundImage:RAIL_HONEYCOMB }} />
      <div style={{ position:'relative', display:'flex', alignItems:'center', justifyContent: compact ? 'center' : 'flex-start', gap:'10px' }}>
        <span data-rail-brand aria-hidden="true" style={{ display:'grid', placeItems:'center', flexShrink:0, width:'44px', height:'36px' }}>{brandMark}</span>
        {!compact && (
          <div style={{ minWidth:0 }}>
            <p style={{ fontSize:'18px', lineHeight:'22px', fontWeight:700, color:T.railFg, fontFamily:FONT.body, whiteSpace:'nowrap' }}>Bee Hub</p>
            <p style={{ marginTop:'2px', fontSize:'11px', lineHeight:'14px', color:T.railMuted, whiteSpace:'nowrap' }}>Bee Organized</p>
          </div>
        )}
        {mobile && (
          <button type="button" data-rail-quiet aria-label="Close menu" onClick={onClose}
            style={{ ...quiet, justifyContent:'center', width:'44px', marginLeft:'auto', color:T.railFg }}><IconX size={20} /></button>
        )}
      </div>
      {/* Ask Bee Hub — kept. See the note at the top of this file. */}
      {ask && <div data-rail-ask style={{ position:'relative', display:'flex', justifyContent: compact ? 'center' : 'flex-start', marginTop:'12px' }}>{ask(compact)}</div>}
    </header>

    {!compact && (
      <label style={{ display:'flex', alignItems:'center', gap:'8px', flexShrink:0, height:'44px', margin:'16px 12px 8px', padding:'0 10px', borderRadius:R.md, border:`1px solid ${alpha(T.railFg, 0.15)}`, background:alpha(T.railFg, 0.05), color:T.railMuted }}>
        <IconSearch size={16} />
        <input data-rail-filter aria-label="Search menu" placeholder="Search menu" value={query} onChange={e => setQuery(e.target.value)}
          style={{ width:'100%', minWidth:0, border:'none', outline:'none', background:'transparent', color:T.railFg, fontFamily:'inherit' }} />
      </label>
    )}

    {/* THE scroll region; everything after it stays pinned. */}
    <nav aria-label="Main navigation" style={{ flex:1, minHeight:0, overflowY:'auto', padding:'16px 8px' }}>
      {!compact && <p style={{ margin:'0 10px 12px', fontSize:'10px', lineHeight:'14px', fontWeight:700, textTransform:'uppercase', color:T.railMuted }}>Workspace</p>}
      <div data-rail-list style={{ display:'flex', flexDirection:'column', gap:'4px' }}>
        {shown.map(it => <RailItem key={it.key} item={it} active={active === it.key} compact={compact} onPick={pick} Badge={Badge} />)}
      </div>
      {shownLower.length > 0 && (
        <div data-rail-list="lower" style={{ display:'flex', flexDirection:'column', gap:'4px', marginTop:'20px', paddingTop:'16px', borderTop:line }}>
          {shownLower.map(it => <RailItem key={it.key} item={it} active={active === it.key} compact={compact} onPick={pick} Badge={Badge} />)}
        </div>
      )}
      {!compact && query.trim() && shown.length + shownLower.length === 0 && (
        <p data-rail-empty style={{ margin:'8px 10px', fontSize:'12px', lineHeight:'16px', color:T.railMuted }}>Nothing in the menu matches “{query.trim()}”.</p>
      )}
    </nav>

    {/* Search (clients, Network people) — kept. Not the menu filter above.
        Not in the phone drawer: on a phone the top bar already has it, and
        the room is better spent showing the whole menu without scrolling. */}
    {onSearch && !mobile && (
      <div style={{ flexShrink:0, padding:'8px', borderTop:line }}>
        <button type="button" data-rail-quiet data-rail-search aria-label="Search clients and contacts" title="Search (⌘K)"
          onClick={() => { onSearch(); if (mobile && onClose) onClose() }}
          style={{ ...quiet, justifyContent: compact ? 'center' : 'flex-start', gap:'8px', padding: compact ? '0' : '0 10px', border:`1px solid ${alpha(T.railFg, 0.15)}`, background:alpha(T.railFg, 0.05) }}>
          <IconSearch size={16} />
          {!compact && <span style={{ flex:1, fontSize:'12px', lineHeight:'16px', textAlign:'left' }}>Search…</span>}
          {!compact && !mobile && <span style={{ borderRadius:R.sm, background:alpha(T.railFg, 0.1), padding:'1px 5px', fontSize:'10px', lineHeight:'14px' }}>⌘K</span>}
        </button>
      </div>
    )}

    <footer style={{ flexShrink:0, borderTop:line, padding: compact ? '10px' : '10px 10px 12px', paddingBottom:'max(12px, env(safe-area-inset-bottom))' }}>
      {/* Expanded: Bee Hub's identity control, whole (view-as, location,
          sign out). On the icon strip there is no room for it, so a face
          stands in and opens the menu back out. */}
      {compact ? (
        account && (
          <button type="button" data-rail-quiet data-rail-account title={`${account.name} — open the menu to switch location or sign out`}
            aria-label={`${account.name}. Open the menu to switch location or sign out`} onClick={onToggle}
            style={{ ...quiet, justifyContent:'center' }}>
            <span style={{ display:'grid', placeItems:'center', width:'36px', height:'36px', borderRadius:R.full, background:T.sage, color:T.primary, fontSize:'12px', fontWeight:700 }}>{account.initials}</span>
          </button>
        )
      ) : (mobile ? mobileFooter : footer)}
      {!mobile && (
        <button type="button" data-rail-quiet data-rail-collapse aria-label={compact ? 'Expand menu' : 'Collapse menu'} title={compact ? 'Expand menu' : 'Collapse menu'}
          aria-expanded={!compact} onClick={onToggle}
          style={{ ...quiet, justifyContent: compact ? 'center' : 'flex-start', gap:'12px', marginTop:'8px', padding: compact ? '0' : '0 8px' }}>
          {compact ? <IconExpand /> : <IconCollapse />}
          {!compact && <span style={{ fontSize:'12px', lineHeight:'16px' }}>Collapse menu</span>}
        </button>
      )}
    </footer>
  </>
}

// ── The menu ──────────────────────────────────────────────────────────────
//   items / lower   the two lists, top and under the line (Help, Admin)
//   active          the current nav key
//   onPick(key)     BeeHub's nav()
//   collapsed / onToggle          the desktop icon strip
//   mobileOpen / onCloseMobile    the phone drawer
//   brandMark       what sits where the logo goes
//   ask(compact)    the Ask Bee Hub button
//   onSearch        open global search
//   footer          the identity control; `account` {name, initials} stands in on the icon strip
//   mobileFooter    what the phone drawer ends with (who you are, and Sign Out), as before
//   Badge           the count badge component (Help's unread replies)
export function AppRail({ items, lower = [], active, onPick, collapsed = false, onToggle, mobileOpen = false, onCloseMobile, brandMark, ask, onSearch, footer, mobileFooter, account, Badge }) {
  const shared = { items, lower, active, onPick, brandMark, ask, onSearch, footer, mobileFooter, account, Badge, onToggle }
  const shell = { background:T.rail, color:T.railFg, fontFamily:FONT.ui, display:'flex', flexDirection:'column' }
  return <>
    <link rel="stylesheet" href={FONT_STYLESHEET_HREF} />
    <style>{APP_RAIL_CSS}</style>

    {/* ≥768px. Shown and hidden by .bee-sidebar in app/globals.css, as before. */}
    <aside className="bee-sidebar" data-app-rail data-collapsed={collapsed ? '' : undefined} aria-label="Bee Hub"
      style={{ ...shell, position:'fixed', top:0, left:0, bottom:0, width:`${collapsed ? RAIL_W_COLLAPSED : RAIL_W}px`, zIndex:99 }}>
      <RailBody compact={collapsed} mobile={false} {...shared} />
    </aside>

    {/* <768px: the same menu, sliding in over the page. Tapping the dimmed
        page, the ×, or Escape closes it. */}
    {mobileOpen && (
      <div data-rail-overlay style={{ position:'fixed', inset:0, zIndex:10003, display:'flex', background:alpha(T.foreground, 0.4) }}
        onKeyDown={e => { if (e.key === 'Escape') onCloseMobile() }}>
        <aside role="dialog" aria-modal="true" aria-label="Bee Hub menu" data-app-rail data-rail-drawer
          style={{ ...shell, width:'320px', maxWidth:'calc(100% - 32px)', height:'100%' }}>
          <RailBody compact={false} mobile {...shared} onClose={onCloseMobile} />
        </aside>
        <button type="button" data-rail-dismiss aria-label="Close menu" onClick={onCloseMobile}
          style={{ flex:1, minWidth:0, height:'100%', border:'none', background:'transparent', cursor:'default' }} />
      </div>
    )}
  </>
}

// ── A closed section ──────────────────────────────────────────────────────
// What someone sees if they arrive on a closed section anyway — a typed
// address, an old bookmark, a link from elsewhere in the app. The same short
// line Settings shows for Tags, in the same look; never the old screen and
// never a blank one.
export function ClosedSection({ title, head, body, onHome }) {
  return (
    <div data-app-rail data-section-closed-page style={{ minHeight:'100vh', background:T.background, fontFamily:FONT.ui, color:T.foreground }}>
      <div style={{ maxWidth:'896px', margin:'0 auto', padding:'40px 16px', boxSizing:'border-box' }}>
        <h1 style={{ fontSize:'30px', lineHeight:'36px', fontWeight:300, fontFamily:FONT.heading }}>{title}</h1>
        <div data-nav-closed style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap:'12px', marginTop:'24px', borderRadius:R.md, background:T.muted, padding:'12px 16px' }}>
          <span style={{ flex:'1 1 280px', minWidth:0, fontSize:'13px', lineHeight:1.5, color:T.mutedFg }}>
            <span style={{ display:'block', fontSize:'14px', lineHeight:'20px', fontWeight:700, color:T.foreground }}>{head}</span>
            {body}
          </span>
          <button type="button" data-closed-home onClick={onHome}
            style={{ display:'inline-flex', alignItems:'center', minHeight:'44px', padding:'6px 12px', borderRadius:R.lg, border:`1px solid ${T.border}`, background:T.card, color:T.foreground, cursor:'pointer', fontFamily:'inherit' }}>
            <span style={{ fontSize:'14px', lineHeight:'20px', fontWeight:500 }}>Go to Home</span>
          </button>
        </div>
      </div>
    </div>
  )
}
