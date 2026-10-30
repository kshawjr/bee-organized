// components/settings/EmailsScreen.jsx
// ─────────────────────────────────────────────────────────────
// Settings → Emails, rebuilt to the designer's export (2026-10-30, the Lovable
// "Emails screen" — its src/components/emails/EmailsScreen.tsx and its tokens
// in src/styles.css). The export is a Vite + Tailwind + Radix app; none of
// that is used here. Its layout, spacing, wording, colours and fonts are
// rebuilt in Bee Hub's own idiom: inline style objects, no UI library.
//
// This file holds the screen's PIECES. components/BeeHub.jsx composes them
// with the parts that already lived there (the email list, the follow-ups
// switch, the editors), so the shared file only gains the composition.
//
// The colours are the export's oklch tokens, converted to hex once here.
// ─────────────────────────────────────────────────────────────
import React from 'react'
import { buildBrandedDripHtml, EMAIL_STYLES, normalizeEmailStyle } from '@/lib/drip-email-layout'
import { SIGNATURE_MARKER } from '@/lib/email-signature'
import { uploadSignaturePhoto } from '@/lib/signature-photo'
import { OWNER_MERGE_TAGS, MERGE_TAG_GROUPS, mergeTagToken, insertAtCursor } from '@/lib/merge-tags'

// ── Tokens (export src/styles.css :root) ──────────────────────────────────
// Exact: the export's oklch values converted to hex (Kevin, 2026-10-30
// follow-up). Use these for EVERYTHING on this screen — its dialogs,
// dropdowns, fields and buttons too, including the parts the export never
// drew.
export const ET = {
  ink: '#595C57',
  gold: '#C69856',
  goldSoft: '#F9EDD9',
  sage: '#A2C7C1',
  sageSoft: '#E4F2F0',
  band: '#F5F5F5',
  background: '#FBFAF8',
  foreground: '#2A302B',
  card: '#FFFFFF',
  secondary: '#F1F3ED',
  primary: '#1A302C',
  primaryFg: '#FBFAF8',
  muted: '#F2F2EE',
  mutedFg: '#676A64',
  destructive: '#B6322B',
  destructiveSoft: '#FFEBE7',
  warning: '#A0600B',
  warningSoft: '#FEF0D4',
  success: '#2F7258',
  successSoft: '#E0F4EA',
  corporate: '#2E5072',
  corporateSoft: '#E5F0FC',
  border: '#E1E2DC',
  input: '#D8D8D1',
}
// Radii — the export's base radius is 10px: sm 6 · md 8 · lg 10 · xl 14 · 2xl 18.
export const ER = { sm: '6px', md: '8px', lg: '10px', xl: '14px', xxl: '18px' }
// Buttons carry a subtle shadow, fields a very subtle one.
export const ESHADOW = {
  btn: '0 1px 3px rgba(42,48,43,0.10), 0 1px 2px rgba(42,48,43,0.06)',
  field: '0 1px 2px rgba(42,48,43,0.05)',
  pop: '0 4px 6px -1px rgba(42,48,43,0.10), 0 2px 4px -2px rgba(42,48,43,0.10)',
  dialog: '0 10px 15px -3px rgba(42,48,43,0.12), 0 4px 6px -4px rgba(42,48,43,0.10)',
}
// A gold rgba for borders "at 50%" and the like.
export const alpha = (hex, a) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}
export const EF = {
  heading: "'Lato', system-ui, sans-serif",
  body: "'Arvo', Georgia, serif",
  script: "'Corinthia', cursive",
  ui: "'Lato', system-ui, sans-serif",
}

// What inline styles cannot say: focus rings, hover fills, disabled, and the
// dialog that becomes a bottom sheet on a phone. Scoped to [data-emails-ui]
// so nothing else in Bee Hub changes.
const EMAILS_CSS = `
[data-emails-ui] :is(button,input,select,textarea,a,[tabindex]):focus-visible{outline:none!important;box-shadow:0 0 0 2px ${ET.gold}!important}
[data-emails-ui] [data-efield]:focus-within{box-shadow:0 0 0 2px ${ET.gold}!important}
[data-emails-ui] [data-ehover="brand"]:not(:disabled):hover{background-color:${alpha(ET.sage, 0.8)}!important}
[data-emails-ui] :is(button,input,select,textarea):disabled{opacity:.5!important;cursor:not-allowed!important}
[data-emails-ui] [data-ehover="muted"]:not(:disabled):hover{background-color:${ET.muted}!important}
[data-emails-ui] [data-ehover="secondary"]:not(:disabled):hover{background-color:${alpha(ET.secondary, 0.8)}!important}
[data-emails-ui] [data-ehover="solid"]:not(:disabled):hover{opacity:.9}
[data-emails-ui] [data-ehover="link"]:not(:disabled):hover{text-decoration:underline}
[data-emails-ui] [role="option"][data-active="true"]{background-color:${ET.muted}}
[data-emails-ui] input::placeholder,[data-emails-ui] textarea::placeholder{color:${alpha(ET.mutedFg, 0.6)}}
[data-edialog]{position:fixed;z-index:81;left:50%;top:50%;transform:translate(-50%,-50%);width:640px;max-width:calc(100vw - 32px);max-height:92vh;overflow-y:auto;box-sizing:border-box;background:${ET.card};border-radius:${ER.xxl};padding:24px;box-shadow:${ESHADOW.dialog}}
@media (max-width:639px){[data-edialog]{left:0;right:0;bottom:0;top:auto;transform:none;width:auto;max-width:none;border-radius:${ER.xxl} ${ER.xxl} 0 0;padding:20px}}
@media (max-width:639px){[data-estack]{flex-direction:column!important;align-items:stretch!important}}
[data-emails-page]{padding:24px 16px}
@media (min-width:640px){[data-emails-page]{padding:40px 32px}}
[data-jumpnav]{margin:0 -16px;padding:8px 16px}
@media (min-width:640px){[data-jumpnav]{margin:0 -32px;padding:8px 32px}}
[data-look-row]{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;margin:0 -4px;padding:0 4px 8px}
[data-look-row]>*{flex:0 0 160px;scroll-snap-align:start}
@media (min-width:640px){[data-look-row]{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));overflow-x:visible}[data-look-row]>*{flex:none}}
[data-emails-ui] [data-handler-q]{flex:1 1 100%;min-width:0}
[data-emails-ui] [data-handler-qs]{flex:1 1 100%;min-width:0}
@media (min-width:640px){[data-emails-ui] [data-handler-q]{flex:0 0 224px}[data-emails-ui] [data-handler-qs]{flex:0 1 auto}}
`

// The export's three web fonts and the CSS above. A plain <link> and <style>
// rendered with the screen (and with each of its dialogs) — no global
// stylesheet change for the rest of Bee Hub.
export function EmailsFonts() {
  return <>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Arvo:wght@400;700&family=Lato:wght@300;400;700&family=Corinthia&display=swap" />
    <style>{EMAILS_CSS}</style>
  </>
}

// ── The design's controls, from the export's component library ────────────
//   button   default 36px · small 32px · 8px radius · 0 16px (small 0 12px)
//            · 14px/500 (small 12px/500)
//   field    36px · 8px · 1px input · 0 12px · 14px
//   select   the field's shape, a chevron on the right; its panel 8px with a
//            1px border, items 6px with 6px 32px 6px 8px padding
//
// CORRECTED 2026-10-30 (Kevin): the export's OWN button on this screen, not
// the component library's — 10px corners, height from 6px × 12px padding,
// 14px/500, no shadow, a 2px gold focus ring (EMAILS_CSS). `sm` is the
// export's `text-xs` override. `brand` is sage on ink, 8px × 16px.
export function eBtnStyle(variant = 'outline', size = 'default') {
  const small = size === 'sm'
  const base = { display:'inline-flex', alignItems:'center', justifyContent:'center', gap:'6px', boxSizing:'border-box',
    padding:'6px 12px', borderRadius:ER.lg,
    fontSize: small ? '12px' : '14px', fontWeight:500, fontFamily:EF.ui, lineHeight: small ? '16px' : '20px', whiteSpace:'nowrap',
    cursor:'pointer', border:'1px solid transparent', textDecoration:'none' }
  const v = {
    primary:     { background:ET.primary, color:ET.primaryFg },
    secondary:   { background:ET.secondary, color:ET.foreground },
    outline:     { background:ET.card, color:ET.foreground, border:`1px solid ${ET.border}` },
    ghost:       { background:'transparent', color:ET.foreground },
    danger:      { background:ET.destructive, color:'#FFFFFF' },
    dangerGhost: { background:'transparent', color:ET.destructive },
    brand:       { background:ET.sage, color:ET.ink, padding:'8px 16px' },
    link:        { background:'transparent', color:ET.primary, padding:0, border:'none', textDecoration:'underline', textUnderlineOffset:'2px' },
  }[variant] || {}
  return { ...base, ...v }
}
const HOVER = { primary:'solid', danger:'solid', secondary:'secondary', outline:'muted', ghost:'muted', dangerGhost:'muted', brand:'brand', link:'link' }

// `secondary` was this file's white bordered button before the exact tokens
// arrived; that look is the library's `outline`, so it maps there.
export function EBtn({ variant = 'outline', size = 'default', style, children, ...p }) {
  const v = variant === 'secondary' ? 'outline' : variant === 'fill' ? 'secondary' : variant
  return <button type="button" data-ehover={HOVER[v]} {...p} style={{ ...eBtnStyle(v, size), ...style }}>{children}</button>
}

// The export's Field: 10px corners, its border colour, card fill, 8px × 12px,
// 14px text (corrected 2026-10-30 — the export wins over the earlier table).
export const eInputStyle = {
  display:'block', width:'100%', boxSizing:'border-box', padding:'8px 12px',
  borderRadius:ER.lg, border:`1px solid ${ET.border}`, background:ET.card,
  fontSize:'14px', lineHeight:'20px', fontFamily:EF.ui, color:ET.foreground, outline:'none',
}
export const eTextareaStyle = { ...eInputStyle, height:'auto', minHeight:'60px', padding:'8px 12px', lineHeight:1.55, resize:'vertical' }
export const eLabelStyle = { display:'block', marginBottom:'4px', fontSize:'14px', fontWeight:600, color:ET.foreground, fontFamily:EF.ui }
export const eHintStyle = { display:'block', marginTop:'4px', fontSize:'12px', color:ET.mutedFg, fontFamily:EF.ui, lineHeight:1.5 }

const Chevron = ({ up = false }) => (
  <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    style={{ flexShrink:0, opacity:0.5, transform: up ? 'rotate(180deg)' : 'none' }}><path d="m6 9 6 6 6-6" /></svg>
)
const Check = () => (
  <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
)

// The design's dropdown. A button that opens a listbox panel — a native
// <select> opens the browser's own list, which can't take this shape.
// Nothing closes on an outside click (Kevin, 2026-09-30): it closes by
// picking, by its own button again, or by Escape / Tab.
//   options [{ value, label }]   onChange(value)
export function ESelect({ id, value, options, onChange, ariaLabel, disabled = false, placeholder = '', style = null, muted = false }) {
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const box = React.useRef(null)
  const list = React.useRef(null)
  const current = options.find(o => String(o.value) === String(value ?? ''))
  React.useEffect(() => { if (open && list.current) list.current.focus() }, [open])
  const show = () => {
    if (disabled) return
    setActive(Math.max(0, options.findIndex(o => String(o.value) === String(value ?? ''))))
    setOpen(true)
  }
  const pick = o => { setOpen(false); if (String(o.value) !== String(value ?? '')) onChange(o.value) }
  const onListKey = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(options.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)) }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (options[active]) pick(options[active]) }
    else if (e.key === 'Escape' || e.key === 'Tab') { setOpen(false) }
  }
  const listId = `${id || ariaLabel || 'eselect'}-list`.replace(/\s+/g, '-')
  return (
    <div ref={box} data-eselect={ariaLabel} style={{ position:'relative', width:'100%', ...style }}>
      <button id={id} type="button" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
        aria-label={ariaLabel} disabled={disabled} data-value={value ?? ''}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); show() } }}
        style={{ ...eInputStyle, display:'flex', alignItems:'center', justifyContent:'space-between', gap:'8px', paddingRight:'12px', textAlign:'left', cursor:'pointer', background:ET.card,
          color: current && !muted ? ET.foreground : ET.mutedFg }}>
        <span style={{ minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{current ? current.label : placeholder}</span>
        <Chevron />
      </button>
      {open && (
        <ul ref={list} id={listId} role="listbox" aria-label={ariaLabel} tabIndex={-1} onKeyDown={onListKey}
          style={{ position:'absolute', zIndex:90, top:'calc(100% + 4px)', left:0, minWidth:'100%', maxHeight:'280px', overflowY:'auto', boxSizing:'border-box',
            margin:0, padding:'4px', listStyle:'none', background:ET.card, border:`1px solid ${ET.border}`, borderRadius:ER.md, boxShadow:ESHADOW.pop, outline:'none' }}>
          {options.map((o, i) => {
            const sel = String(o.value) === String(value ?? '')
            return (
              <li key={String(o.value)} role="option" aria-selected={sel} data-value={o.value} data-active={i === active}
                onMouseEnter={() => setActive(i)} onMouseDown={e => e.preventDefault()} onClick={() => pick(o)}
                style={{ position:'relative', padding:'6px 32px 6px 8px', borderRadius:ER.sm, fontSize:'14px', fontFamily:EF.ui, color:ET.foreground, cursor:'pointer', whiteSpace:'nowrap' }}>
                {o.label}
                {sel && <span style={{ position:'absolute', right:'8px', top:'50%', transform:'translateY(-50%)', display:'flex' }}><Check /></span>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// The export's dialog: a 640px card with 18px corners, a bottom sheet on a
// phone; the overlay is the foreground colour at 40%. Title row with a close
// button, then the body, then the footer buttons on the right.
//   label     the dialog's accessible name
//   eyebrow   small gold line above the title (the export's timing line)
export function EDialog({ label, eyebrow = null, title, onClose, children, footer = null, width = null, role = 'dialog' }) {
  React.useEffect(() => {
    if (!onClose) return undefined
    const esc = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose])
  return (
    <div data-emails-ui>
      <EmailsFonts />
      {/* The overlay closes nothing (Kevin, 2026-09-30): ✕, Cancel or Escape. */}
      <div aria-hidden style={{ position:'fixed', inset:0, zIndex:80, background:alpha(ET.foreground, 0.4) }} />
      <div data-edialog role={role} aria-modal="true" aria-label={label} style={{ fontFamily:EF.ui, color:ET.foreground, ...(width ? { width } : null) }}>
        <div style={{ marginBottom:'16px', display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:'12px' }}>
          <div style={{ minWidth:0 }}>
            {eyebrow && <p style={{ margin:'0 0 2px', fontSize:'12px', fontWeight:600, color:ET.gold }}>{eyebrow}</p>}
            <h2 style={{ margin:0, fontSize:'18px', fontWeight:600, lineHeight:1.25, color:ET.foreground, fontFamily:EF.heading }}>{title}</h2>
          </div>
          {onClose && (
            <button type="button" aria-label="Close" data-ehover="muted" onClick={onClose}
              style={{ flexShrink:0, display:'flex', padding:'4px', borderRadius:ER.md, border:'none', background:'transparent', color:ET.foreground, cursor:'pointer' }}>
              <svg aria-hidden width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          )}
        </div>
        {children}
        {footer && <div style={{ marginTop:'16px', display:'flex', flexWrap:'wrap', justifyContent:'flex-end', gap:'8px' }}>{footer}</div>}
      </div>
    </div>
  )
}

// A note box inside a dialog or panel (the export's rounded-lg p-3 text-xs).
export function ENote({ tone = 'muted', children, style = null }) {
  const t = { muted:[ET.muted, ET.foreground], gold:[ET.goldSoft, ET.foreground], warning:[ET.warningSoft, ET.foreground], corporate:[ET.corporateSoft, ET.corporate], danger:[ET.destructiveSoft, ET.destructive] }[tone]
  return <div style={{ borderRadius:ER.lg, background:t[0], color:t[1], padding:'12px', fontSize:'12px', lineHeight:1.55, fontFamily:EF.ui, ...style }}>{children}</div>
}

// The export's radio option card (the Moving clients choice): 10px corners,
// 1px border, 12px × 8px, a 16px dot that becomes a 5px ring when chosen.
export function ERadioCard({ on, onClick, disabled = false, children, style = null }) {
  return (
    <button type="button" role="radio" aria-checked={on} disabled={disabled} onClick={onClick} data-ehover={on ? undefined : 'muted'}
      style={{ flex:'1 1 240px', display:'flex', alignItems:'center', gap:'8px', boxSizing:'border-box', borderRadius:ER.lg,
        border:`1px solid ${on ? ET.primary : ET.border}`, background: on ? ET.sageSoft : ET.card, padding:'8px 12px', textAlign:'left',
        fontSize:'14px', fontWeight: on ? 600 : 400, color:ET.foreground, fontFamily:EF.ui, cursor:'pointer', ...style }}>
      <span aria-hidden style={{ height:'16px', width:'16px', flexShrink:0, borderRadius:'999px', boxSizing:'border-box', border: on ? `5px solid ${ET.primary}` : `2px solid ${ET.border}` }} />
      {children}
    </button>
  )
}

// Scroll a field into view and focus it (the export's goTo).
export function goToField(id) {
  if (typeof document === 'undefined') return
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  setTimeout(() => { if (el.focus) el.focus() }, 400)
}

// ── What a blank detail holds back ────────────────────────────────────────
export const NEED_LABEL = {
  rate: 'your hourly rate',
  discoveryBooking: 'your discovery call booking link',
  booking: 'your in-home assessment booking link',
  virtualBooking: 'your virtual assessment booking link',
  ownerBooking: 'your own booking link',
}
export const FIELD_ID = {
  rate: 'field-rate',
  discoveryBooking: 'field-discovery-booking',
  booking: 'field-booking',
  virtualBooking: 'field-virtual-booking',
  ownerBooking: 'field-booking',
  reviews: 'field-reviews',
  fromEmail: 'field-from-email',
}

const blank = (v) => v == null || String(v).trim() === ''

// Which blank details hold this row back — the same rules as the send-time
// guards (lib/rate-guard.ts, lib/booking-link.ts).
//   cfg { ratePerHour, ownerBookingLink, locationCalendarLink,
//         discoveryBookingLink, virtualBookingLink }
export function rowNeeds(row, cfg = {}) {
  const src = `${row?.subject ?? ''}\n${row?.body ?? ''}\n${row?.buttonLink ?? ''}`
  const out = []
  if (src.includes('{{rate_per_hour}}') && blank(cfg.ratePerHour)) out.push('rate')
  if (src.includes('{{discovery_booking_link}}') && blank(cfg.discoveryBookingLink)) out.push('discoveryBooking')
  if ((src.includes('{{booking_link}}') || src.includes('{{book_assessment_link}}')) && blank(cfg.locationCalendarLink)) out.push('booking')
  if (src.includes('{{virtual_booking_link}}') && blank(cfg.virtualBookingLink)) out.push('virtualBooking')
  if (src.includes('{{owner_booking_link}}') && blank(cfg.ownerBookingLink)) out.push('ownerBooking')
  return out
}

// ── Small primitives (export "small primitives") ──────────────────────────
export function ETag({ tone, children }) {
  const t = {
    shared:    [ET.goldSoft, ET.warning],
    own:       [ET.sageSoft, ET.primary],
    held:      [ET.destructiveSoft, ET.destructive],
    corporate: [ET.corporateSoft, ET.corporate],
    ok:        [ET.successSoft, ET.success],
  }[tone] || [ET.muted, ET.mutedFg]
  return <span style={{ display:'inline-flex', alignItems:'center', gap:'4px', whiteSpace:'nowrap', borderRadius:'999px', padding:'2px 8px', fontSize:'11px', fontWeight:600, background:t[0], color:t[1], fontFamily:EF.ui }}>{children}</span>
}

export function CorporateTag() {
  return <ETag tone="corporate">🛡 Corporate only</ETag>
}

// The export's Section: 18px corners, 20px padding (24px is its desktop
// step-up), a dashed corporate-blue border on the corporate-only one.
//   collapsible  the whole header becomes the fold — the export's group
//                header button (EmailList :552): full width, 14px corners,
//                1px border, 12px padding, muted on hover, a chevron that
//                turns. `defaultOpen` false starts it shut (the corporate
//                library — 26 templates, 12 headings).
export function ESection({ id, eyebrow, title, intro, right, children, corporate, collapsible = false, defaultOpen = true }) {
  const [open, setOpen] = React.useState(defaultOpen)
  const shut = collapsible && !open
  const eyebrowStyle = { margin:'0 0 4px', display:'flex', alignItems:'center', gap:'8px', fontSize:'11px', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.14em', color:ET.gold, fontFamily:EF.ui }
  const titleStyle = { margin:0, fontSize:'20px', fontWeight:300, color:ET.foreground, fontFamily:EF.heading }
  const introStyle = { margin:'4px 0 0', maxWidth:'672px', fontFamily:EF.body, fontSize:'13px', lineHeight:1.6, color:ET.mutedFg }
  return (
    <section id={id} data-section-open={collapsible ? String(open) : undefined}
      style={{ scrollMarginTop:'112px', borderRadius:ER.xxl, border:`1px ${corporate ? 'dashed' : 'solid'} ${corporate ? alpha(ET.corporate, 0.3) : ET.border}`, background:ET.card, padding:'20px', minWidth:0 }}>
      {collapsible ? (
        <h2 style={{ margin: shut ? 0 : '0 0 20px', fontSize:'inherit', fontWeight:'inherit' }}>
          <button type="button" aria-expanded={open} aria-controls={`${id}-body`} data-fold-header data-ehover="muted" onClick={() => setOpen(o => !o)}
            style={{ display:'flex', width:'100%', boxSizing:'border-box', alignItems:'flex-start', gap:'12px', borderRadius:ER.xl, border:`1px solid ${ET.border}`, background:ET.card, padding:'12px', textAlign:'left', cursor:'pointer', color:ET.foreground, fontFamily:EF.ui }}>
            <span style={{ minWidth:0, flex:1, display:'block' }}>
              <span style={eyebrowStyle}>{eyebrow}{corporate && <CorporateTag />}</span>
              <span style={{ ...titleStyle, display:'block' }}>{title}</span>
              {intro && <span style={{ ...introStyle, display:'block' }}>{intro}</span>}
            </span>
            <svg aria-hidden width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              style={{ marginTop:'4px', flexShrink:0, color:ET.mutedFg, transform: open ? 'rotate(180deg)' : 'none', transition:'transform 150ms' }}><path d="m6 9 6 6 6-6" /></svg>
          </button>
        </h2>
      ) : (
        <div style={{ marginBottom:'20px', display:'flex', flexWrap:'wrap', alignItems:'flex-start', justifyContent:'space-between', gap:'12px' }}>
          <div style={{ minWidth:0 }}>
            <p style={eyebrowStyle}>{eyebrow}{corporate && <CorporateTag />}</p>
            <h2 style={titleStyle}>{title}</h2>
            {intro && <p style={introStyle}>{intro}</p>}
          </div>
          {right}
        </div>
      )}
      {!shut && <div id={`${id}-body`}>{children}</div>}
    </section>
  )
}

// A field that saves when it loses focus (or on Enter), and says so.
//   onSave(value) → Promise<string|null>   null = saved, string = the problem
export function EField({ id, label, value, onSave, hint, required, placeholder, problem, readOnly, type = 'text' }) {
  const [draft, setDraft] = React.useState(value ?? '')
  const [state, setState] = React.useState(null)   // null | 'saving' | 'saved' | {err}
  React.useEffect(() => { setDraft(value ?? '') }, [value])
  const commit = async () => {
    if (readOnly || !onSave || (draft ?? '') === (value ?? '')) return
    setState('saving')
    const err = await onSave(draft)
    setState(err ? { err } : 'saved')
    if (!err) setTimeout(() => setState(s => (s === 'saved' ? null : s)), 1600)
  }
  const shownProblem = (state && state.err) || problem
  return (
    <label style={{ display:'block' }}>
      <span style={{ marginBottom:'4px', display:'flex', alignItems:'center', gap:'8px', fontSize:'14px', fontWeight:600, color:ET.foreground, fontFamily:EF.ui }}>
        {label}
        {required && <span style={{ fontSize:'11px', fontWeight:600, color:ET.mutedFg }}>Required</span>}
        {state === 'saving' && <span style={{ fontSize:'11px', fontWeight:400, color:ET.mutedFg }}>Saving…</span>}
        {state === 'saved' && <span style={{ fontSize:'11px', fontWeight:600, color:ET.success }}>Saved</span>}
      </span>
      <input id={id} type={type} value={draft} placeholder={placeholder} readOnly={readOnly}
        onChange={e => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit() } }}
        style={{ ...eInputStyle, background: readOnly ? ET.muted : ET.card,
          ...(shownProblem ? { borderColor:ET.destructive, boxShadow:`0 0 0 1px ${alpha(ET.destructive, 0.4)}` } : null) }} />
      {shownProblem
        ? <span style={{ marginTop:'4px', display:'flex', alignItems:'center', gap:'4px', fontSize:'12px', fontWeight:500, color:ET.destructive, fontFamily:EF.ui }}>⚠ {shownProblem}</span>
        : hint && <span style={{ marginTop:'4px', display:'block', fontSize:'12px', color:ET.mutedFg, fontFamily:EF.ui }}>{hint}</span>}
    </label>
  )
}

export function UseToggle({ label, on, onChange, onText, offText, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)}
      style={{ display:'flex', alignItems:'flex-start', gap:'12px', borderRadius:ER.xl, border:`1px solid ${on ? alpha(ET.gold, 0.5) : ET.border}`, background: on ? ET.goldSoft : ET.muted, padding:'16px', textAlign:'left', cursor:'pointer', color:ET.foreground, fontFamily:EF.ui }}>
      <span style={{ marginTop:'2px', display:'flex', height:'24px', width:'44px', flexShrink:0, alignItems:'center', borderRadius:'999px', padding:'2px', background: on ? ET.gold : alpha(ET.mutedFg, 0.4), boxSizing:'border-box', transition:'background 150ms' }}>
        <span style={{ height:'20px', width:'20px', borderRadius:'999px', background:ET.card, boxShadow:'0 1px 2px rgba(0,0,0,0.2)', transform: on ? 'translateX(20px)' : 'none', transition:'transform 150ms' }} />
      </span>
      <span style={{ minWidth:0 }}>
        <span style={{ display:'block', fontSize:'14px', fontWeight:600, color:ET.foreground }}>{label} <span style={{ fontWeight:400, color:ET.mutedFg }}>· {on ? 'Yes' : 'No'}</span></span>
        <span style={{ marginTop:'2px', display:'block', fontSize:'12px', color:ET.mutedFg }}>{on ? onText : offText}</span>
      </span>
    </button>
  )
}

export const notSetUpNote = (what) => (
  <p style={{ margin:'8px 0 0', fontSize:'12px', color:ET.warning, fontFamily:EF.ui }}>{what} isn’t switched on yet — it saves once Bee Organized finishes setting it up.</p>
)

// ── Status (export StatusPanel) ───────────────────────────────────────────
//   held  [{ need, subjects:[…] }]
export function EmailStatusPanel({ sending, locationName, fromEmail, held, activeCount, totalCount, someOff, onStartSending }) {
  const [draft, setDraft] = React.useState('')
  const [err, setErr] = React.useState(null)
  if (!sending) {
    return (
      <div role="alert" style={{ borderRadius:ER.xxl, border:`2px solid ${ET.destructive}`, background:ET.destructiveSoft, padding:'20px', fontFamily:EF.ui }}>
        <div style={{ display:'flex', gap:'12px' }}>
          <span aria-hidden style={{ fontSize:'22px', lineHeight:1, color:ET.destructive }}>⛔</span>
          <div style={{ flex:1 }}>
            <h2 style={{ margin:0, fontSize:'18px', fontWeight:700, color:ET.destructive, fontFamily:EF.heading }}>No emails are going out from {locationName || 'your location'}</h2>
            <p style={{ margin:'4px 0 0', fontFamily:EF.body, fontSize:'14px', color:alpha(ET.foreground, 0.8), lineHeight:1.6 }}>Clients who get in touch aren't getting even the first thank-you, because there's no address to send from. Add your Bee Organized email address and everything starts again straight away.</p>
            {onStartSending && (
              <form onSubmit={async e => { e.preventDefault(); if (!/\S+@\S+\.\S+/.test(draft)) return; const problem = await onStartSending(draft.trim()); setErr(problem || null) }}
                style={{ marginTop:'16px', display:'flex', flexWrap:'wrap', gap:'8px' }}>
                <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="you@beeorganized.com" aria-label="Send from email"
                  style={{ ...eInputStyle, flex:'1 1 220px', width:'auto', background:ET.card, borderColor:alpha(ET.destructive, 0.4) }} />
                <EBtn variant="danger" type="submit">Start sending</EBtn>
              </form>
            )}
            {err && <p style={{ margin:'8px 0 0', fontSize:'12px', color:ET.destructive }}>⚠ {err}</p>}
            <p style={{ margin:'8px 0 0', fontSize:'12px', color:ET.mutedFg }}>Use your Bee Organized address, not a personal Gmail.</p>
          </div>
        </div>
      </div>
    )
  }
  if (held.length) {
    const count = held.reduce((n, h) => n + h.subjects.length, 0)
    return (
      <div role="status" style={{ borderRadius:ER.xxl, border:`2px solid ${alpha(ET.warning, 0.5)}`, background:ET.warningSoft, padding:'20px', fontFamily:EF.ui }}>
        <div style={{ display:'flex', gap:'12px' }}>
          <span aria-hidden style={{ fontSize:'20px', lineHeight:1, color:ET.warning }}>⏸</span>
          <div style={{ flex:1 }}>
            <h2 style={{ margin:0, fontSize:'18px', fontWeight:700, color:ET.foreground, fontFamily:EF.heading }}>{count} {count === 1 ? 'email is' : 'emails are'} waiting on you</h2>
            <p style={{ margin:'4px 0 0', fontFamily:EF.body, fontSize:'14px', color:alpha(ET.foreground, 0.8) }}>Everything else is sending. These are skipped for every client until the missing detail is filled in.</p>
            <ul style={{ listStyle:'none', padding:0, margin:'16px 0 0', display:'flex', flexDirection:'column', gap:'8px' }}>
              {held.map(h => (
                <li key={h.need} style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap:'8px', borderRadius:ER.xl, background:ET.card, padding:'12px' }}>
                  <div style={{ flex:'1 1 240px', fontSize:'14px' }}>
                    <p style={{ margin:0, fontWeight:600 }}>Add {NEED_LABEL[h.need]}</p>
                    <p style={{ margin:0, fontSize:'12px', color:ET.mutedFg }}>Holding back: {h.subjects.map(s => `“${s}”`).join(', ')}</p>
                  </div>
                  <EBtn variant="primary" onClick={() => goToField(FIELD_ID[h.need])}>Add it</EBtn>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div role="status" style={{ display:'flex', alignItems:'center', gap:'12px', borderRadius:ER.xxl, border:`1px solid ${ET.border}`, background:ET.successSoft, padding:'16px 20px', fontSize:'14px', fontFamily:EF.ui }}>
      <span aria-hidden style={{ color:ET.success, fontSize:'18px' }}>✓</span>
      <p style={{ margin:0, fontSize:'14px' }}><span style={{ fontWeight:600 }}>{someOff ? `${activeCount} of ${totalCount} emails are sending` : `All ${activeCount} emails are sending`}</span> <span style={{ color:ET.mutedFg }}>from {fromEmail}</span></p>
    </div>
  )
}

export function EmailsJumpNav({ corporate }) {
  const items = [['sender', 'Sending'], ['details', 'Your details'], ['style', 'Look'], ['signature', 'Signature'], ['emails', 'The emails'], ...(corporate ? [['masters', 'Bee Organized versions']] : [])]
  return (
    <nav aria-label="On this page" data-jumpnav style={{ position:'sticky', top:0, zIndex:30, display:'flex', gap:'4px', overflowX:'auto', borderBottom:`1px solid ${ET.border}`, background:alpha(ET.background, 0.95), backdropFilter:'blur(6px)' }}>
      {items.map(([id, l]) => (
        <a key={id} href={`#${id}`} onClick={e => { e.preventDefault(); const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior:'smooth', block:'start' }) }}
          style={{ flexShrink:0, borderRadius:'999px', padding:'4px 12px', fontSize:'14px', color:ET.mutedFg, textDecoration:'none', fontFamily:EF.ui }}>{l}</a>
      ))}
    </nav>
  )
}

// ── Look (export StyleSection) ────────────────────────────────────────────
// The designer's sample — the first-response email — so every card shows a
// button. Real values are never needed for a thumbnail.
const SAMPLE_BODY = `Jordan,

Thank you for reaching out! We would be honored to help you with your home organization and decluttering. Our team creates custom solutions that are functional and sustainable for your needs and lifestyle.

A 30-minute video or phone call. Prefer to talk now? Just reply to this email.`

export function sampleEmailHtml(style) {
  return buildBrandedDripHtml(SAMPLE_BODY, {
    location_name: 'Central Denver',
    location_phone: '(303) 555-0142',
    reviews_link: null,
    style,
    heading: 'Thank you for reaching out!',
    button: { label: 'Book a Discovery Call', href: 'https://beeorganized.com' },
  })
}

// A real email in an iframe, scaled to the box (export ScaledFrame). The
// iframe has no allow-scripts, so nothing in it can run.
export function EmailFrame({ html, fit = false }) {
  const box = React.useRef(null)
  const frame = React.useRef(null)
  const [scale, setScale] = React.useState(fit ? 0.3 : 1)
  const [height, setHeight] = React.useState(1100)
  React.useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => setScale(Math.min(1, el.clientWidth / 600)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const onLoad = () => {
    try {
      const doc = frame.current && frame.current.contentDocument
      if (doc) setHeight(doc.documentElement.scrollHeight)
    } catch { /* sandboxed — keep the default height */ }
  }
  const shown = fit ? Math.min(height, 700) : height
  return (
    <div ref={box} style={{ width:'100%' }}>
      <div style={{ height: shown * scale, overflow:'hidden', borderRadius:'6px', border:`1px solid ${ET.border}` }}>
        <iframe ref={frame} onLoad={onLoad} title="Email preview" srcDoc={html} scrolling="no" tabIndex={-1} sandbox="allow-same-origin"
          style={{ width:600, height, transform:`scale(${scale})`, transformOrigin:'top left', border:0, pointerEvents: fit ? 'none' : 'auto' }} />
      </div>
    </div>
  )
}

export function EmailStyleSection({ style, onPick, ready = true, saving = false }) {
  const current = normalizeEmailStyle(style)
  const htmlFor = React.useMemo(() => Object.fromEntries(EMAIL_STYLES.map(s => [s.id, sampleEmailHtml(s.id)])), [])
  return (
    <ESection id="style" eyebrow="Look" title="How your emails look"
      intro="Pick one look for every email you send. Your logo, colours and wording stay the same — only the button changes. Most locations keep Soft.">
      {/* Layout is EMAILS_CSS [data-look-row]: a snap-scrolling row of 160px
          cards on a phone, five equal columns from 640px (export StyleSection). */}
      <div role="radiogroup" aria-label="Email look" data-look-row>
        {EMAIL_STYLES.map(s => {
          const on = current === s.id
          return (
            <button key={s.id} type="button" role="radio" aria-checked={on} disabled={!ready || saving} onClick={() => onPick(s.id)}
              style={{ minWidth:0, borderRadius:ER.xl, border:`2px solid ${on ? ET.gold : 'transparent'}`, background:ET.band, padding:'8px', textAlign:'left', cursor: ready ? 'pointer' : 'default', boxShadow: on ? '0 4px 10px rgba(0,0,0,0.08)' : 'none', fontFamily:EF.ui }}>
              <EmailFrame html={htmlFor[s.id]} fit />
              <div style={{ marginTop:'8px', display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0 4px' }}>
                <span style={{ fontSize:'14px', fontWeight:600, color:ET.foreground }}>{s.name}</span>
                {on
                  ? <span style={{ display:'grid', placeItems:'center', height:'20px', width:'20px', borderRadius:'999px', background:ET.gold, color:ET.card, fontSize:'12px' }}>✓</span>
                  : s.id === 'soft' ? <span style={{ fontSize:'10px', fontWeight:600, textTransform:'uppercase', color:ET.mutedFg }}>Default</span> : null}
              </div>
              <p style={{ margin:0, padding:'0 4px', fontSize:'12px', color:ET.mutedFg }}>{s.note}</p>
            </button>
          )
        })}
      </div>
      {!ready && notSetUpNote('Choosing a look')}
    </ESection>
  )
}

// ── Previewing one email exactly as it would go ───────────────────────────
// Fill the tags the way a send does, with this location's real values and a
// sample client; wrap in the location's style with the subject as heading
// and the email's button.
export function previewEmailHtml({ row, style, values, signature = null }) {
  const sw = { subject: row?.subject ?? '', body: row?.body ?? '', buttonLink: row?.buttonLink || '' }
  const fill = (text, marker) => String(text || '').replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (k === 'signature') return marker ? SIGNATURE_MARKER : ''
    const v = values[k]
    return v == null ? '' : String(v)
  })
  const subject = fill(sw.subject, false)
  const body = fill(sw.body, true)
  const buttonLink = fill(sw.buttonLink, false)
  return buildBrandedDripHtml(body, {
    location_name: values.location_name,
    location_phone: values.location_phone,
    reviews_link: values.reviews_link,
    signature,
    style,
    heading: subject,
    button: row?.buttonText && buttonLink ? { label: fill(row.buttonText, false), href: buttonLink } : null,
  })
}

// "Send me a test" (export, in the read dialog). POSTs to the real send path.
export function SendTestBar({ locationId, row, sending }) {
  const [state, setState] = React.useState(null)   // null | 'busy' | { to } | { err }
  const target = row?.rail === 'drip' ? (row.stepId ? { stepId: row.stepId } : null) : (row?.templateKey ? { templateKey: row.templateKey } : null)
  const can = !!locationId && !!target && sending
  const send = async () => {
    setState('busy')
    try {
      const r = await fetch('/api/emails/test-send', { method:'POST', credentials:'include', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ locationId, ...target }) })
      const j = await r.json().catch(() => ({}))
      setState(r.ok ? { to: j.to } : { err: j.message || 'The test could not be sent. Try again.' })
    } catch {
      setState({ err: 'The test could not be sent. Try again.' })
    }
  }
  const tested = state && state.to
  return (
    <div style={{ marginTop:'16px', display:'flex', flexWrap:'wrap', alignItems:'center', gap:'8px', borderRadius:ER.lg, background:ET.muted, padding:'12px', fontSize:'12px', fontFamily:EF.ui }}>
      <span aria-hidden style={{ color:ET.mutedFg }}>✉</span>
      <span style={{ flex:1 }}>
        {tested ? <>Sent to <b>{state.to}</b>. Check your inbox in a minute.</>
          : state && state.err ? <span style={{ color:ET.destructive }}>{state.err}</span>
          : !sending ? 'Add a send-from address before you can send a test.'
          : !target ? 'Save this email once before sending yourself a test.'
          : 'See it exactly as a client will, in your own inbox.'}
      </span>
      <EBtn size="sm" disabled={!can || state === 'busy' || !!tested} onClick={send}>{tested ? 'Test sent' : state === 'busy' ? 'Sending…' : 'Send me a test'}</EBtn>
    </div>
  )
}

// ── Your details (export DetailsSection) ──────────────────────────────────
// The rate, the in-home link (calendar_link) and the reviews link save through
// PATCH /api/locations/[id] as they always did; the two new links through
// PATCH /api/locations/[id]/email-settings.
//
// THE TWO SWITCHES ARE THE SEQUENCE VARIANT (Kevin, 2026-10-30 follow-up).
// "I share my hourly rate" and "Clients book through a link" are the two
// questions that pick a location's sequences — a (rate, reply), b (rate,
// link), c (no rate, reply), d (no rate, link) — stored as default_drip_path /
// default_move_drip_path. No column of their own: they READ the location's
// current variant and a flip WRITES the variant, exactly as the retired
// "two questions" modal did (components/BeeHub.jsx emailsSetVariant).
//
// THE GUARD IS THE SWITCH'S OWN. Turning a switch ON when its prerequisite
// is blank (no rate / no booking link) does NOT save. The switch opens a
// field for the missing value; only once that is saved does the variant
// change. Otherwise the location would land on a variant whose every email is
// held — loc_carmel's state (variantPrerequisiteMissing).
//
//   variant   { split, sequences: [{ key: 'both'|'organizing'|'moving', label, rate, link }] }
//   onVariant(key, { rate?, link? }, known) → Promise<problem|null>
//             known: values just saved here, so the guard sees them at once
//   counts    { rate, discoveryBooking, booking, virtualBooking, reviews }
//   waiting   { rate, discoveryBooking, booking, virtualBooking }
export function VariantSwitch({ label, on, need, haveValue, onText, offText, disabled, onTurn, onSaveValue, testId }) {
  const [asking, setAsking] = React.useState(false)
  const [value, setValue] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [problem, setProblem] = React.useState(null)
  const flip = async (next) => {
    setProblem(null)
    if (next && !haveValue) { setAsking(true); return }      // ask first, save nothing
    setBusy(true)
    const p = await onTurn(next, {})
    setBusy(false)
    if (p) setProblem(p)
  }
  const confirm = async () => {
    const v = value.trim()
    if (!v) return
    setBusy(true); setProblem(null)
    const p1 = await onSaveValue(v)
    if (p1) { setBusy(false); setProblem(p1); return }
    const p2 = await onTurn(true, need === 'rate' ? { ratePerHour: v } : { locationCalendarLink: v })
    setBusy(false)
    if (p2) { setProblem(p2); return }
    setAsking(false); setValue('')
  }
  const what = need === 'rate' ? 'your hourly rate' : 'your booking link'
  return (
    <div data-variant-switch={testId}>
      <UseToggle label={label} on={on} disabled={disabled || busy} onChange={flip} onText={onText} offText={offText} />
      {asking && !on && (
        <div role="group" aria-label={`Add ${what}`} style={{ marginTop:'8px', borderRadius:ER.xl, border:`1px solid ${alpha(ET.warning, 0.5)}`, background:ET.warningSoft, padding:'12px', fontFamily:EF.ui }}>
          <label style={{ display:'block', fontSize:'13px', fontWeight:600, color:ET.foreground }}>
            {need === 'rate' ? 'Your hourly rate' : 'Your booking link'}
            <input autoFocus value={value} onChange={e => setValue(e.target.value)} placeholder={need === 'rate' ? '$85' : 'https://calendly.com/…'}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); confirm() } }}
              style={{ ...eInputStyle, marginTop:'6px', background:ET.card, fontWeight:400 }} />
          </label>
          <p style={{ margin:'6px 0 0', fontSize:'12px', color:ET.warning }}>We need {what} before this can turn on — it’s written into your emails, so without it they’d wait.</p>
          <div style={{ marginTop:'8px', display:'flex', gap:'8px' }}>
            <EBtn variant="primary" disabled={!value.trim() || busy} onClick={confirm}>{busy ? 'Saving…' : 'Turn it on'}</EBtn>
            <EBtn onClick={() => { setAsking(false); setValue(''); setProblem(null) }}>Cancel</EBtn>
          </div>
        </div>
      )}
      {problem && <p style={{ margin:'6px 0 0', fontSize:'12px', color:ET.destructive, fontFamily:EF.ui }}>⚠ {problem}</p>}
    </div>
  )
}

export function EmailDetailsSection({ rate, calendarLink, reviewsLink, options, ready, counts, waiting, nothingWaiting, onSaveLocation, onSaveOption, variant, onVariant }) {
  const seqs = (variant && variant.sequences) || []
  const usesRates = seqs.some(q => q.rate)
  const usesLinks = seqs.some(q => q.link)
  const prob = (k) => (waiting[k] ? `${waiting[k]} ${waiting[k] === 1 ? 'email is' : 'emails are'} waiting for this` : undefined)
  const used = (k, extra = '') => `Used in ${counts[k] || 0} email${counts[k] === 1 ? '' : 's'}${extra}`
  const canSwitch = !!onVariant
  return (
    <ESection id="details" eyebrow="Your details" title="What your emails mention"
      intro="These are written into your emails for you. If one is blank, the emails that need it are skipped.">
      {seqs.map(q => (
        <div key={q.key} data-variant-seq={q.key} style={{ marginBottom:'20px' }}>
          {q.label && <p style={{ margin:'0 0 8px', fontSize:'12px', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.08em', color:ET.mutedFg, fontFamily:EF.ui }}>{q.label}</p>}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(260px, 1fr))', gap:'12px' }}>
            <VariantSwitch testId={`${q.key}-rate`} label="I share my hourly rate" on={q.rate} need="rate" haveValue={!blank(rate)} disabled={!canSwitch}
              onTurn={(v, known) => onVariant(q.key, { rate: v }, known)} onSaveValue={v => onSaveLocation('rate', v)}
              onText="Your rate is written into the first email." offText="No rate is mentioned. The first email still goes out, without the price line." />
            <VariantSwitch testId={`${q.key}-link`} label="Clients book through a link" on={q.link} need="link" haveValue={!blank(calendarLink)} disabled={!canSwitch}
              onTurn={(v, known) => onVariant(q.key, { link: v }, known)} onSaveValue={v => onSaveLocation('booking', v)}
              onText="Emails include your booking links." offText="Clients reply to book instead — your emails ask them to reply rather than click a link." />
          </div>
        </div>
      ))}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(260px, 1fr))', gap:'16px' }}>
        {usesRates && <EField id="field-rate" label="Hourly rate" value={rate || ''} placeholder="$85" problem={prob('rate')} hint={used('rate')} onSave={v => onSaveLocation('rate', v)} />}
        <EField id="field-reviews" label="Google Reviews link" value={reviewsLink || ''} placeholder="https://g.page/…" hint={used('reviews')} onSave={v => onSaveLocation('reviews', v)} />
        {usesLinks && <>
          <EField id="field-discovery-booking" label="Discovery call booking link" value={options.discoveryBookingLink || ''} placeholder="https://calendly.com/…" readOnly={!ready.links}
            problem={prob('discoveryBooking')} hint={ready.links ? used('discoveryBooking', ' · only needed if you offer them') : 'Isn’t switched on yet.'} onSave={v => onSaveOption({ discovery_booking_link: v })} />
          <EField id="field-booking" label="In-home assessment booking link" value={calendarLink || ''} placeholder="https://calendly.com/…"
            problem={prob('booking')} hint={used('booking')} onSave={v => onSaveLocation('booking', v)} />
          <EField id="field-virtual-booking" label="Virtual assessment booking link" value={options.virtualBookingLink || ''} placeholder="https://calendly.com/…" readOnly={!ready.links}
            problem={prob('virtualBooking')} hint={ready.links ? used('virtualBooking', ' · only needed if you offer them') : 'Isn’t switched on yet.'} onSave={v => onSaveOption({ virtual_booking_link: v })} />
        </>}
      </div>
      {nothingWaiting && <p style={{ margin:'16px 0 0', display:'flex', alignItems:'center', gap:'6px', fontSize:'12px', color:ET.success, fontFamily:EF.ui }}>✓ Nothing is waiting on these.</p>}
    </ESection>
  )
}

// ── Signature (export SignatureSection) ───────────────────────────────────
// One signature, one place. The headshot and title (hub_users, PATCH
// /api/signature) and the location's website and social links (PATCH
// /api/locations/[id]) used to live on Profile and Location. Name, email and
// mobile are the signer's PROFILE — shown here, changed on Profile, so there
// is never a second editable copy of a person's name or phone.
//   onSignature(sig)  hands the resolved signature up for the email previews
const LINK_FIELDS = [
  { key:'website_url', label:'Website', placeholder:'beeorganized.com/your-town' },
  { key:'facebook_url', label:'Facebook', placeholder:'Optional' },
  { key:'instagram_url', label:'Instagram', placeholder:'Optional' },
  { key:'linkedin_url', label:'LinkedIn', placeholder:'Optional' },
]

export function useSignature(locationId, skip = false) {
  const [data, setData] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [tick, setTick] = React.useState(0)
  React.useEffect(() => {
    if (skip) return undefined
    let alive = true
    const qs = locationId ? `?locationId=${encodeURIComponent(locationId)}` : ''
    fetch(`/api/signature${qs}`, { credentials:'include' })
      .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j })
      .then(j => { if (alive) { setData(j); setError(null) } })
      .catch(e => { if (alive) setError(e.message || String(e)) })
    return () => { alive = false }
  }, [locationId, tick, skip])
  return { data, error, reload: () => setTick(t => t + 1) }
}

// The API's answer as the layout's EmailSignature (lib/email-signature.ts).
export function signatureFromData(data) {
  if (!data || !data.person) return null
  const p = data.person, l = data.links || {}
  return {
    name: p.name ?? null, title: p.title ?? null, email: p.email ?? null, mobile: p.mobile ?? null,
    photoPath: p.photoPath ?? null,
    websiteUrl: l.website_url ?? null, facebookUrl: l.facebook_url ?? null, instagramUrl: l.instagram_url ?? null, linkedinUrl: l.linkedin_url ?? null,
    locationName: data.location?.name ?? null,
  }
}

export function EmailSignatureSection({ locationId, sig }) {
  const { data, error, reload } = sig
  const fileRef = React.useRef(null)
  const [busy, setBusy] = React.useState(null)
  const [problem, setProblem] = React.useState(null)
  const target = data?.target || null
  const person = data?.person || null
  const canEdit = !!(target && target.canEdit) && !(data?.storageReady && data.storageReady.person === false)
  const linksOff = !!(data?.storageReady && data.storageReady.links === false)
  const photoUrl = person?.photoUrl || null

  async function patchSignature(body) {
    const res = await fetch('/api/signature', { method:'PATCH', credentials:'include', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ locationId: data?.location?.id || locationId, targetUserId: target?.targetId, ...body }) })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) return j.error || 'That did not save. Try again.'
    reload()
    return null
  }
  async function saveLink(column, value) {
    const res = await fetch(`/api/locations/${data?.location?.id || locationId}`, { method:'PATCH', credentials:'include', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ [column]: value }) })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) return j.error || 'That did not save. Try again.'
    reload()
    return null
  }
  async function onPick(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    setProblem(null)
    try { await uploadSignaturePhoto(file, { locationId: data?.location?.id || locationId, targetUserId: target?.targetId, onStatus: setBusy }); reload() }
    catch (err) { setProblem(err.message || String(err)) }
    finally { setBusy(null) }
  }

  return (
    <ESection id="signature" eyebrow="Signature" title="How you sign off" intro="Added to the bottom of any email that includes your signature.">
      {error && <p style={{ fontSize:'12px', color:ET.destructive, fontFamily:EF.ui }}>Couldn’t load the signature: {error}</p>}
      {!data && !error && <p style={{ fontSize:'12px', color:ET.mutedFg, fontFamily:EF.ui }}>Loading signature…</p>}
      {data && !target && <p style={{ fontSize:'12px', color:ET.mutedFg, fontFamily:EF.ui }}>Open a location to see its email signature.</p>}
      {data && target && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(280px, 1fr))', gap:'24px' }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(200px, 1fr))', gap:'16px' }}>
            {target.explainer && !target.isSelf && <p style={{ gridColumn:'1 / -1', margin:0, fontSize:'12px', color:ET.warning, fontFamily:EF.ui }}>{target.heading} — {target.explainer}</p>}
            <div style={{ gridColumn:'1 / -1', display:'flex', alignItems:'center', gap:'12px' }}>
              {photoUrl
                ? <img src={photoUrl} alt={`${person?.name || 'Signature'} headshot`} width={56} height={56} style={{ width:'56px', height:'56px', borderRadius:'999px', objectFit:'cover' }} />
                : <span style={{ display:'grid', placeItems:'center', height:'56px', width:'56px', borderRadius:'999px', border:`2px dashed ${ET.border}`, fontSize:'12px', color:ET.mutedFg, fontFamily:EF.ui }}>None</span>}
              {canEdit && <>
                <input ref={fileRef} type="file" accept="image/*" onChange={onPick} style={{ display:'none' }} />
                <EBtn disabled={!!busy} onClick={() => fileRef.current && fileRef.current.click()}>{busy || (photoUrl ? 'Change photo' : 'Add a photo')}</EBtn>
                {photoUrl && !busy && <EBtn variant="ghost" onClick={() => patchSignature({ signature_photo_path: '' })}>Remove</EBtn>}
              </>}
            </div>
            <EField label="Name" value={person?.name || ''} readOnly hint="From the profile — change it on Settings → Profile." />
            <EField label="Job title" value={person?.title || ''} placeholder="Owner & Lead Organizer" readOnly={!canEdit}
              onSave={v => patchSignature({ signature_title: v.trim() })} />
            <EField label="Phone" value={person?.mobile || ''} readOnly hint="From the profile — change it on Settings → Profile." />
            {LINK_FIELDS.map(f => (
              <EField key={f.key} label={f.label} value={data.links?.[f.key] || ''} placeholder={f.placeholder} readOnly={linksOff}
                onSave={v => saveLink(f.key, v)} />
            ))}
            {problem && <p style={{ gridColumn:'1 / -1', margin:0, fontSize:'12px', color:ET.destructive, fontFamily:EF.ui }}>⚠ {problem}</p>}
          </div>
          <div style={{ borderRadius:ER.xl, background:ET.band, padding:'16px' }}>
            <p style={{ margin:'0 0 12px', fontSize:'11px', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.08em', color:ET.mutedFg, fontFamily:EF.ui }}>Clients see</p>
            {data.preview?.html
              ? <iframe title="Signature preview" sandbox="" srcDoc={data.preview.html} style={{ width:'100%', height:'200px', border:0, background:'white', borderRadius:'8px' }} />
              : <p style={{ fontSize:'12px', color:ET.mutedFg }}>No signature yet.</p>}
          </div>
        </div>
      )}
    </ESection>
  )
}

// ── The optional button (Kevin, 2026-10-30) ──────────────────────────────
// "Button text" + "Button link". Both filled in → the email shows a button in
// the location's style; either blank → no button. The link can be a tag such
// as {{booking_link}}, filled in per client like the wording.
export function ButtonFields({ text, link, onText, onLink, labelStyle = null, inputStyle = null }) {
  const lab = labelStyle || eLabelStyle
  const inp = inputStyle || eInputStyle
  return (
    <div data-button-fields style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(200px, 1fr))', gap:'12px' }}>
      <label style={{ display:'block' }}>
        <span style={lab}>Button text <span style={{ fontWeight:400, color:ET.mutedFg }}>· optional</span></span>
        <input type="text" value={text} maxLength={60} placeholder="Book a time" onChange={e => onText(e.target.value)} style={inp} />
      </label>
      <label style={{ display:'block' }}>
        <span style={lab}>Button link <span style={{ fontWeight:400, color:ET.mutedFg }}>· optional</span></span>
        <input type="text" value={link} placeholder="{{booking_link}}" onChange={e => onLink(e.target.value)} style={inp} />
      </label>
      <p style={{ gridColumn:'1 / -1', margin:0, fontSize:'12px', color:ET.mutedFg, lineHeight:1.5 }}>
        Fill in both and the email shows a button in your chosen look. Leave either blank for no button. The link can be one of your booking links, like <code>{'{{booking_link}}'}</code>, <code>{'{{discovery_booking_link}}'}</code> or <code>{'{{virtual_booking_link}}'}</code>.
      </p>
    </div>
  )
}

// ── Merge tags an owner can click in (2026-10-30) ─────────────────────────
// lib/merge-tags.ts is the list; this is how an editor offers it. Grouped
// chips; the description of the chip under the pointer or focus shows below,
// and "What each one means" lists them all (phones have no hover).
//
// useTagInsert: an editor binds its subject / body fields with bind(), and a
// chip lands where the cursor was in the field last used — never just
// appended at the end.
export function useTagInsert() {
  const last = React.useRef(null)       // { el, get, set }
  const bind = (get, set) => ({
    onFocus: e => { last.current = { el: e.target, get, set } },
    onSelect: e => { last.current = { el: e.target, get, set } },
  })
  const insert = (token) => {
    const t = last.current
    if (!t) return false
    const { next, caret } = insertAtCursor(t.get(), token, t.el.selectionStart, t.el.selectionEnd)
    t.set(next)
    setTimeout(() => { try { t.el.focus(); t.el.setSelectionRange(caret, caret) } catch { /* detached */ } }, 0)
    return true
  }
  return { bind, insert, hasTarget: () => !!last.current }
}

export function MergeTagPicker({ onInsert, tags = OWNER_MERGE_TAGS }) {
  const [hint, setHint] = React.useState(null)
  const [all, setAll] = React.useState(false)
  return (
    <div data-merge-tag-picker style={{ fontFamily:EF.ui }}>
      <p style={{ margin:'0 0 6px', fontSize:'14px', fontWeight:600, color:ET.foreground }}>Insert a detail <span style={{ fontSize:'12px', fontWeight:400, color:ET.mutedFg }}>· click where it should go, then pick one</span></p>
      {MERGE_TAG_GROUPS.map(g => {
        const inGroup = tags.filter(t => t.group === g.id)
        if (!inGroup.length) return null
        return (
          <div key={g.id} style={{ marginBottom:'6px' }}>
            <p style={{ margin:'0 0 4px', fontSize:'10px', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em', color:ET.mutedFg }}>{g.title}</p>
            <div style={{ display:'flex', flexWrap:'wrap', gap:'5px' }}>
              {inGroup.map(t => (
                <button key={t.key} type="button" data-merge-tag={t.key} title={t.description}
                  onMouseDown={e => e.preventDefault()}   // keep the field's cursor
                  onMouseEnter={() => setHint(t)} onFocus={() => setHint(t)}
                  onClick={() => onInsert(mergeTagToken(t.key))}
                  data-ehover="muted"
                  style={{ height:'28px', padding:'0 10px', borderRadius:'999px', cursor:'pointer', border:`1px solid ${ET.border}`, background:ET.sageSoft, fontSize:'12px', fontFamily:'inherit', color:ET.primary, fontWeight:500 }}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        )
      })}
      <p aria-live="polite" style={{ margin:'4px 0 0', minHeight:'16px', fontSize:'12px', color:ET.mutedFg, lineHeight:1.5 }}>
        {hint ? <><code>{mergeTagToken(hint.key)}</code> — {hint.description}</> : null}
      </p>
      <button type="button" onClick={() => setAll(a => !a)} style={{ marginTop:'2px', background:'none', border:'none', padding:0, fontSize:'12px', color:ET.primary, textDecoration:'underline', textUnderlineOffset:'2px', cursor:'pointer', fontFamily:'inherit' }}>
        {all ? 'Hide what each one means' : 'What each one means'}
      </button>
      {all && (
        <dl style={{ margin:'6px 0 0', fontSize:'12px', lineHeight:1.5, color:ET.mutedFg }}>
          {tags.map(t => (
            <div key={t.key} style={{ marginBottom:'4px' }}>
              <dt style={{ display:'inline', fontWeight:600, color:ET.foreground }}>{t.label} <code style={{ fontWeight:400 }}>{mergeTagToken(t.key)}</code></dt>
              <dd style={{ display:'inline', margin:'0 0 0 6px' }}>{t.description}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
