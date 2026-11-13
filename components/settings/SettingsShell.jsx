// components/settings/SettingsShell.jsx
// ─────────────────────────────────────────────────────────────
// Settings, rebuilt to the designer's export — slice 1 of 4 (2026-11-13, the
// Lovable "Settings" export: src/components/settings/SettingsShell.tsx,
// Rows.tsx and the Profile page in pages.tsx).
//
// Same pattern as components/settings/EmailsScreen.jsx: the export is a
// Vite + Tailwind + Radix + lucide app and NONE of that is used. Its layout,
// spacing, wording, colours and fonts are rebuilt in Bee Hub's own idiom —
// inline style objects, no UI library — and this file holds the PIECES.
// components/BeeHub.jsx composes them, so everything that decides WHO sees
// WHAT and everything that SAVES stays where it already was:
//
//   · The nav here draws whatever groups it is handed. It has no list of
//     sections and no idea what a role is. SECTION_GROUPS in BeeHub.jsx —
//     with its ownerConfig / canSeeTeamScreen / canManageOwnTags predicates
//     and its "drop a group with nothing in it" filter — is untouched and is
//     the only thing that decides what a manager is offered. (The export's
//     nav has no roles in it at all; rebuilding the nav FROM the export
//     would hand a manager links to screens the server refuses.)
//   · A row here shows a value and hands back what was typed. The PATCH is
//     persistProfileField / persistBookingLink in BeeHub.jsx, as before.
//
// What is NOT taken from the export: its dark left-hand app rail (Bee Hub
// has its own, outside Settings) and its phone menu button — the phone keeps
// the drill-down list from issue 246, where back is real navigation.
//
// Colours, corners and fonts come from components/design/tokens.js. This
// file declares none of its own.
//
// FONTS: Lato and Arvo reach only what carries [data-settings-ui] — the nav,
// the back control and a rebuilt page. A Settings section that has not been
// rebuilt yet sits OUTSIDE any such element and keeps DM Sans from the
// SettingsScreen root, so it looks exactly as it did.
// ─────────────────────────────────────────────────────────────
import React from 'react'
import { T, R, FONT, FONT_STYLESHEET_HREF, HONEYCOMB, alpha } from '@/components/design/tokens'
// Reused from Bee Hub's own icon set (Tabler outlines, already inline SVG).
import {
  IconUsers, IconMail, IconMessage, IconMapPin, IconBell, IconSend,
  IconPencil, IconLogout, IconCheck, IconChevronRight,
} from '@/components/ui/icons'

// ── Icons Bee Hub did not have ────────────────────────────────────────────
// Drawn here as inline SVG in the same shape as components/ui/icons.jsx
// (24×24, 2px stroke, currentColor). No icon package.
const draw = (children) => function Icon({ size = 16, style = {} }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ flexShrink: 0, display: 'block', ...style }}>
      {children}
    </svg>
  )
}
export const IconUser = draw(<><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6 -6h4a6 6 0 0 1 6 6v1" /></>)
export const IconTag = draw(<><path d="M3 11V4a1 1 0 0 1 1 -1h7l10 10l-8 8z" /><circle cx="7.5" cy="7.5" r="1" /></>)
export const IconHash = draw(<><path d="M5 9h14" /><path d="M5 15h14" /><path d="M10 4l-2 16" /><path d="M16 4l-2 16" /></>)
export const IconLink = draw(<><path d="M10 14a4 4 0 0 0 5.66 0l3 -3a4 4 0 0 0 -5.66 -5.66l-1 1" /><path d="M14 10a4 4 0 0 0 -5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1 -1" /></>)
export const IconSliders = draw(<><path d="M20 7h-9" /><path d="M14 17H5" /><circle cx="17" cy="17" r="3" /><circle cx="7" cy="7" r="3" /></>)
export const IconLock = draw(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>)
export const IconKey = draw(<><circle cx="8" cy="15" r="4" /><path d="M11 12l9 -9" /><path d="M17 6l3 3" /><path d="M14 9l2 2" /></>)
export const IconCircleCheck = draw(<><circle cx="12" cy="12" r="9" /><path d="M8.5 12.5l2.5 2.5l4.5 -5" /></>)
export const IconChevronLeft = draw(<path d="M15 6l-6 6l6 6" />)

// One outline per section KEY. The key is all the nav is told about a
// section besides its label, so a section added to SECTION_GROUPS later still
// draws (with the sliders mark) rather than breaking the list.
const SECTION_ICONS = {
  profile: IconUser,
  location: IconMapPin,
  team: IconUsers,
  tags: IconTag,
  emails: IconMail,
  texts: IconMessage,
  newleads: IconBell,
  slack: IconHash,
  jobber: IconLink,
  mailchimp: IconSend,
}
const iconFor = key => SECTION_ICONS[key] || IconSliders

// ── What inline styles cannot say ─────────────────────────────────────────
// Focus rings, hover fills and the two widths. Every rule starts with
// [data-settings-ui] (or a data-s* name only this file writes), so nothing
// outside the rebuilt parts of Settings can match.
//
// The font-size rules carry !important for one reason: app/globals.css sets
// `input,select,button,textarea{font-size:16px!important}`. That is also why
// every button below puts its words in a <span> with its own size.
const RAIL_W = '224px'
export const SETTINGS_CSS = `
[data-settings-ui]{-webkit-tap-highlight-color:transparent}
[data-settings-ui] :is(button,input,a,[tabindex]):focus-visible{outline:none!important;box-shadow:0 0 0 2px ${T.gold}!important}
[data-settings-ui] [data-shover="muted"]:hover{background-color:${T.muted}!important}
[data-settings-ui] [data-shover="brand"]:hover{background-color:${alpha(T.sage, 0.8)}!important}
[data-settings-ui] [data-shover="fade"]:hover{opacity:.8}
[data-settings-ui] input::placeholder{color:${alpha(T.mutedFg, 0.6)}}
[data-settings-ui] input[data-sinput]{scroll-margin-top:96px}
[data-settings-page]{padding:24px 16px}
[data-ssection]{padding:20px}
[data-ssection-head]{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;align-items:start;min-width:0}
[data-srow]{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:8px;row-gap:4px;align-items:start;padding:14px 0;border-bottom:1px solid ${T.border}}
[data-saction]{border-bottom:1px solid ${T.border}}
[data-srow]:last-child,[data-saction]:last-child{border-bottom:0}
[data-srow-label]{grid-column:span 2;min-width:0}
[data-sident-pill]{grid-column:span 2}
[data-semails-link]{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;align-items:center}
@media (min-width:640px){
[data-settings-page]{padding:40px 32px}
[data-ssection]{padding:24px}
[data-ssection-head]{grid-template-columns:minmax(0,1fr) auto}
[data-srow]{grid-template-columns:176px minmax(0,1fr) auto;gap:16px}
[data-srow-label]{grid-column:auto;padding-top:12px}
[data-sident-pill]{grid-column:2}
[data-semails-link]{grid-template-columns:minmax(0,1fr) auto}
[data-settings-ui] input[data-sinput]{font-size:14px!important}
}
@media (prefers-reduced-motion:reduce){[data-settings-ui] *{animation-duration:.01ms!important;transition-duration:.01ms!important}}
`

// The fonts and the CSS above, rendered WITH Settings — a plain <link> and
// <style>, the way EmailsFonts does it. Nothing is added to app/layout.tsx or
// globals.css, so no other screen ever asks for Lato or Arvo.
export function SettingsFonts() {
  return <>
    <link rel="stylesheet" href={FONT_STYLESHEET_HREF} />
    <style>{SETTINGS_CSS}</style>
  </>
}

// ── The nav ───────────────────────────────────────────────────────────────
// `groups` is SECTION_GROUPS from BeeHub.jsx, already filtered for the
// viewer's role: [{ title, items:[{ key, label }] }]. Drawn as given.
const groupTitle = { fontSize:'10px', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.14em', color:T.mutedFg, fontFamily:FONT.ui }

// ≥768px — the grouped sub-nav beside the section. Which of the two navs is
// on screen is still decided by the bee-settings-* rules in globals.css.
// The "Settings" title sits OUTSIDE the <nav>, so the nav's children are the
// groups and nothing else.
export function SettingsRail({ groups, active, onOpen }) {
  return (
    <aside className="bee-settings-rail" data-settings-ui
      style={{ flex:`0 0 ${RAIL_W}`, width:RAIL_W, alignSelf:'stretch', background:T.card, borderRight:`1px solid ${T.border}`, fontFamily:FONT.ui }}>
      <div style={{ position:'sticky', top:0, maxHeight:'100vh', overflowY:'auto', padding:'28px 12px' }}>
        <p style={{ display:'flex', alignItems:'center', gap:'8px', padding:'0 8px', marginBottom:'24px', fontSize:'18px', fontWeight:300, color:T.foreground, fontFamily:FONT.heading }}>
          <IconSliders size={16} style={{ color:T.gold }} />Settings
        </p>
        <nav data-settings-nav="rail" aria-label="Settings sections">
          {groups.map(group => (
            <div key={group.title} style={{ marginBottom:'20px' }}>
              <p style={{ ...groupTitle, padding:'0 8px', marginBottom:'4px' }}>{group.title}</p>
              {group.items.map(sec => {
                const isActive = active === sec.key
                const Icon = iconFor(sec.key)
                return (
                  <button key={sec.key} type="button" data-section={sec.key}
                    aria-current={isActive ? 'page' : undefined}
                    data-shover={isActive ? undefined : 'muted'}
                    onClick={() => onOpen(sec.key, { push:false })}
                    style={{ display:'flex', alignItems:'center', gap:'10px', width:'100%', padding:'6px 8px', borderRadius:R.md, border:'none', background:isActive ? T.primary : 'transparent', cursor:'pointer', fontFamily:'inherit', textAlign:'left', transition:'background-color .15s' }}>
                    <span aria-hidden="true" style={{ display:'flex', flexShrink:0, opacity:0.7, color:isActive ? T.primaryFg : T.foreground }}><Icon size={16} /></span>
                    <span style={{ fontSize:'14px', lineHeight:'20px', fontWeight:isActive ? 700 : 400, color:isActive ? T.primaryFg : alpha(T.foreground, 0.8) }}>{sec.label}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </nav>
      </div>
    </aside>
  )
}

// <768px — the drill-down list. Same groups, same order, one row each.
// Rows are 52px tall with 16px labels (the floor issue 246 set). Tapping one
// is a pushState (BeeHub.jsx openSection), so back returns to this list.
export function SettingsDrill({ groups, hidden, onOpen }) {
  const cls = `bee-settings-drill${hidden ? ' bee-settings-hide-mobile' : ''}`
  return <>
    <div className={cls} data-settings-ui style={{ padding:'24px 16px 16px', fontFamily:FONT.ui }}>
      <p style={{ display:'flex', alignItems:'center', gap:'8px', fontSize:'24px', fontWeight:300, color:T.foreground, fontFamily:FONT.heading }}>
        <IconSliders size={18} style={{ color:T.gold }} />Settings
      </p>
    </div>
    <nav className={cls} data-settings-nav="drill" data-settings-ui aria-label="Settings sections"
      style={{ padding:'0 16px 24px', fontFamily:FONT.ui }}>
      {groups.map(group => (
        <div key={group.title} style={{ marginBottom:'20px' }}>
          <p style={{ ...groupTitle, fontSize:'11px', margin:'0 4px 6px' }}>{group.title}</p>
          <div style={{ borderRadius:R.xxl, overflow:'hidden', border:`1px solid ${T.border}`, background:T.card }}>
            {group.items.map((sec, i) => {
              const Icon = iconFor(sec.key)
              return (
                <button key={sec.key} type="button" data-section={sec.key} data-shover="muted"
                  onClick={() => onOpen(sec.key, { push:true })}
                  style={{ display:'flex', alignItems:'center', gap:'12px', width:'100%', minHeight:'52px', padding:'14px 16px', background:T.card, border:'none', borderBottom: i < group.items.length - 1 ? `1px solid ${T.border}` : 'none', cursor:'pointer', fontFamily:'inherit', textAlign:'left' }}>
                  <span aria-hidden="true" style={{ display:'flex', flexShrink:0, color:T.mutedFg }}><Icon size={18} /></span>
                  <span style={{ fontSize:'16px', fontWeight:400, color:T.foreground }}>{sec.label}</span>
                  <span aria-hidden="true" style={{ display:'flex', marginLeft:'auto', color:T.mutedFg }}><IconChevronRight size={16} style={{ verticalAlign:0 }} /></span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </nav>
  </>
}

// <768px, inside a section — back to the list. `onBack` is history.back().
export function SettingsBack({ onBack }) {
  return (
    <button type="button" className="bee-settings-back" data-settings-ui data-shover="fade" onClick={onBack}
      style={{ alignItems:'center', gap:'6px', width:'100%', minHeight:'48px', padding:'12px 16px', background:T.card, border:'none', borderBottom:`1px solid ${T.border}`, cursor:'pointer', fontFamily:FONT.ui, textAlign:'left' }}>
      <span aria-hidden="true" style={{ display:'flex', color:T.gold }}><IconChevronLeft size={18} /></span>
      <span style={{ fontSize:'16px', fontWeight:700, color:T.foreground }}>All settings</span>
    </button>
  )
}

// ── A rebuilt page ────────────────────────────────────────────────────────
// The export's column: centred, 896px at most, 16px sides on a phone and
// 32px from 640px, 24px between blocks. It paints its own background, so it
// reads the same whatever the SettingsScreen root is painted.
export function SettingsPage({ children }) {
  return (
    <div data-settings-ui style={{ background:T.background, minWidth:0 }}>
      <div data-settings-page style={{ maxWidth:'896px', minWidth:0, margin:'0 auto', boxSizing:'border-box', display:'flex', flexDirection:'column', gap:'24px', fontFamily:FONT.ui, color:T.foreground }}>
        {children}
      </div>
    </div>
  )
}

export function PageHeader({ title, intro }) {
  return (
    <header>
      <h1 style={{ fontSize:'30px', lineHeight:'36px', fontWeight:300, color:T.foreground, fontFamily:FONT.heading }}>{title}</h1>
      {intro && <p style={{ marginTop:'4px', fontFamily:FONT.body, fontSize:'14px', lineHeight:'20px', color:T.mutedFg }}>{intro}</p>}
    </header>
  )
}

// The card: a small uppercase gold eyebrow over a light heading.
export function Section({ eyebrow, title, intro, right, children }) {
  return (
    <section data-ssection style={{ borderRadius:R.xxl, border:`1px solid ${T.border}`, background:T.card, minWidth:0 }}>
      <div data-ssection-head style={{ marginBottom:'20px' }}>
        <div style={{ minWidth:0 }}>
          <p style={{ marginBottom:'4px', fontSize:'11px', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.14em', color:T.gold, fontFamily:FONT.ui }}>{eyebrow}</p>
          <h2 style={{ fontSize:'20px', lineHeight:'28px', fontWeight:300, color:T.foreground, fontFamily:FONT.heading }}>{title}</h2>
          {intro && <p style={{ marginTop:'4px', maxWidth:'672px', fontFamily:FONT.body, fontSize:'13px', lineHeight:1.625, color:T.mutedFg }}>{intro}</p>}
        </div>
        {right && <div style={{ minWidth:0 }}>{right}</div>}
      </div>
      {children}
    </section>
  )
}

const PILL_TONES = {
  own:    { background:T.sageSoft,    color:T.primary },
  shared: { background:T.goldSoft,    color:T.warning },
  ok:     { background:T.successSoft, color:T.success },
  warn:   { background:T.warningSoft, color:T.warning },
}
export function Pill({ tone = 'own', children }) {
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:'4px', whiteSpace:'nowrap', borderRadius:R.full, padding:'2px 8px', fontSize:'11px', lineHeight:'16px', fontWeight:700, fontFamily:FONT.ui, ...(PILL_TONES[tone] || PILL_TONES.own) }}>{children}</span>
  )
}

// A label, its value, and a pencil. Click the value or the pencil to edit;
// Enter or leaving the field saves, Escape puts it back.
//
// `onSave(text)` is the caller's own save (trimmed text in, as the row it
// replaces sent). The row NEVER paints what was typed: it shows `value`,
// which the caller changes only once the write has landed — so a refused
// save leaves the old value on screen. "Saved" shows unless onSave answers
// false, which is how the caller says the write did not land.
//
// `hint` is a short line under the label. `note` is for anything longer: it
// sits under the VALUE, where it has the row's width, rather than being
// stacked ten lines deep in the 176px label column.
export function EditRow({ label, value, hint, note, readOnly, placeholder, type = 'text', onSave }) {
  const shown = value == null ? '' : String(value)
  const [editing, setEditing] = React.useState(false)
  const [state, setState] = React.useState(null) // null | 'saving' | 'saved'
  const settled = React.useRef(true)   // has this edit already been saved or cancelled?
  const alive = React.useRef(true)
  React.useEffect(() => () => { alive.current = false }, [])

  const begin = () => { if (readOnly) return; settled.current = false; setEditing(true) }
  const cancel = () => { settled.current = true; setEditing(false) }
  // Enter removes the input, which blurs it: `settled` makes that one save.
  const commit = async (raw) => {
    if (settled.current) return
    settled.current = true
    setEditing(false)
    const next = String(raw ?? '').trim()
    if (next === shown.trim() || !onSave) return
    setState('saving')
    const ok = await onSave(next)
    if (!alive.current) return
    setState(ok === false ? null : 'saved')
    if (ok !== false) setTimeout(() => { if (alive.current) setState(s => (s === 'saved' ? null : s)) }, 1800)
  }

  const valueText = { fontSize:'14px', lineHeight:'20px', fontFamily:FONT.ui, textAlign:'left', overflowWrap:'anywhere', minWidth:0,
    color: shown ? T.foreground : T.mutedFg, fontStyle: shown ? 'normal' : 'italic' }

  return (
    <div data-srow data-settings-row={label}>
      <div data-srow-label>
        <p style={{ fontSize:'14px', lineHeight:'20px', fontWeight:700, color:T.foreground, fontFamily:FONT.ui }}>{label}</p>
        {hint && <p style={{ marginTop:'2px', fontSize:'12px', lineHeight:1.625, color:T.mutedFg, fontFamily:FONT.ui }}>{hint}</p>}
      </div>
      <div style={{ minWidth:0 }}>
      <div style={{ display:'flex', alignItems:'center', gap:'8px', minWidth:0, minHeight:'44px' }}>
        {editing ? (
          <input autoFocus data-sinput type={type} defaultValue={shown} placeholder={placeholder} aria-label={label}
            onBlur={e => commit(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') commit(e.currentTarget.value); if (e.key === 'Escape') cancel() }}
            style={{ minHeight:'44px', width:'100%', minWidth:0, boxSizing:'border-box', borderRadius:R.lg, border:`1px solid ${T.border}`, background:T.card, padding:'8px 12px', fontFamily:FONT.ui, color:T.foreground, outline:'none' }} />
        ) : readOnly ? (
          <p data-row-value style={{ ...valueText, padding:'8px 0' }}>{shown || 'Not set'}</p>
        ) : (
          <button type="button" onClick={begin} aria-label={`${label}: ${shown || 'Not set'}. Edit`}
            style={{ display:'block', minHeight:'44px', minWidth:0, padding:'8px 0', background:'none', border:'none', borderRadius:R.md, cursor:'text', fontFamily:'inherit', textAlign:'left' }}>
            <span data-row-value style={{ ...valueText, display:'block' }}>{shown || 'Not set'}</span>
          </button>
        )}
        {state === 'saving' && <span role="status" style={{ flexShrink:0, fontSize:'12px', color:T.mutedFg, fontFamily:FONT.ui }}>Saving…</span>}
        {state === 'saved' && (
          <span role="status" style={{ display:'flex', flexShrink:0, alignItems:'center', gap:'4px', fontSize:'12px', fontWeight:700, color:T.success, fontFamily:FONT.ui }}>
            <IconCheck size={14} style={{ verticalAlign:0 }} />Saved
          </span>
        )}
      </div>
      {note && <p data-row-note style={{ marginTop:'2px', maxWidth:'560px', fontSize:'12px', lineHeight:1.625, color:T.mutedFg, fontFamily:FONT.ui }}>{note}</p>}
      </div>
      {!editing && (readOnly
        ? <span title="Read-only" role="img" aria-label="Read-only" style={{ display:'grid', placeItems:'center', width:'44px', height:'44px', color:alpha(T.mutedFg, 0.6) }}><IconLock size={14} /></span>
        : (
          <button type="button" aria-label={`Edit ${label}`} data-shover="muted" onClick={begin}
            style={{ display:'grid', placeItems:'center', width:'44px', height:'44px', borderRadius:R.lg, border:'none', background:'transparent', color:T.mutedFg, cursor:'pointer', transition:'background-color .15s' }}>
            <IconPencil size={16} style={{ verticalAlign:0 }} />
          </button>
        ))}
    </div>
  )
}

// A full-width action with an icon tile on the left and a chevron on the right.
export function ActionRow({ icon, label, danger, onClick }) {
  return (
    <button type="button" data-saction data-shover="fade" onClick={onClick}
      style={{ display:'flex', alignItems:'center', gap:'12px', width:'100%', minHeight:'44px', padding:'16px 0', background:'none', borderTop:'none', borderLeft:'none', borderRight:'none', cursor:'pointer', fontFamily:'inherit', textAlign:'left', transition:'opacity .15s' }}>
      <span aria-hidden="true" style={{ display:'grid', placeItems:'center', flexShrink:0, width:'36px', height:'36px', borderRadius:R.lg, background:danger ? T.destructiveSoft : T.goldSoft, color:danger ? T.destructive : T.warning }}>{icon}</span>
      <span style={{ fontSize:'14px', lineHeight:'20px', fontWeight:700, color:danger ? T.destructive : T.foreground, fontFamily:FONT.ui }}>{label}</span>
      <span aria-hidden="true" style={{ display:'flex', marginLeft:'auto', color:T.mutedFg }}><IconChevronRight size={16} style={{ verticalAlign:0 }} /></span>
    </button>
  )
}

// "X now lives on Emails" — the dashed sage note with the Open Emails button.
export function EmailsLink({ what, onOpen }) {
  return (
    <div data-semails-link style={{ borderRadius:R.xxl, border:`1px dashed ${T.border}`, background:alpha(T.sageSoft, 0.5), padding:'16px 20px' }}>
      <p style={{ fontFamily:FONT.body, fontSize:'13px', lineHeight:'20px', color:T.mutedFg }}>
        {what} now lives on <span style={{ fontWeight:700, color:T.foreground }}>Emails</span>, with everything else your emails use.
      </p>
      <button type="button" data-shover="brand" onClick={onOpen}
        style={{ display:'inline-flex', alignItems:'center', justifyContent:'center', gap:'6px', minHeight:'44px', padding:'8px 16px', borderRadius:R.lg, border:'none', background:T.sage, color:T.ink, cursor:'pointer', fontFamily:FONT.ui, transition:'background-color .15s' }}>
        <span style={{ fontSize:'13px', fontWeight:500, textTransform:'uppercase', letterSpacing:'0.04em' }}>Open Emails</span>
        <IconChevronRight size={16} style={{ verticalAlign:0 }} />
      </button>
    </div>
  )
}

// The card at the top of Profile: initials on gold, the name, role and
// location, over the faint honeycomb.
const initialsOf = name => String(name || '').split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase()
export function IdentityCard({ name, sub, children }) {
  return (
    <div data-sident style={{ display:'grid', gridTemplateColumns:'auto minmax(0,1fr)', alignItems:'center', gap:'16px', borderRadius:R.xxl, border:`1px solid ${T.border}`, backgroundColor:T.card, backgroundImage:HONEYCOMB, padding:'20px' }}>
      <span aria-hidden="true" style={{ display:'grid', placeItems:'center', flexShrink:0, width:'64px', height:'64px', borderRadius:R.full, background:T.gold, boxShadow:`0 0 0 4px ${T.card}`, fontSize:'20px', fontWeight:700, color:T.foreground, fontFamily:FONT.ui }}>{initialsOf(name) || '·'}</span>
      <div style={{ minWidth:0 }}>
        <p style={{ fontSize:'18px', lineHeight:'28px', fontWeight:700, color:T.foreground, fontFamily:FONT.ui, overflowWrap:'anywhere' }}>{name || 'Your name'}</p>
        {sub && <p style={{ fontSize:'14px', lineHeight:'20px', color:T.mutedFg, fontFamily:FONT.ui, overflowWrap:'anywhere' }}>{sub}</p>}
      </div>
      {children && <div data-sident-pill>{children}</div>}
    </div>
  )
}

// Re-exported under a name that says what it is on this screen.
export const IconSignOut = IconLogout

// Settings sections already rebuilt to the new look. Each slice adds its keys
// here. BeeHub.jsx paints the screen PAGE_BG behind one of these and leaves
// the old cream behind every other section, so a short rebuilt page has no
// band of the old colour under it.
export const REBUILT_SECTIONS = ['profile']
export const PAGE_BG = T.background
