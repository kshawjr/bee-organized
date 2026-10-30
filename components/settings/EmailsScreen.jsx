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
export const ET = {
  ink: '#60625F',
  gold: '#C89A56',
  goldSoft: '#F8EEDD',
  sage: '#A8C9C4',
  sageSoft: '#EAF3F1',
  band: '#F5F5F5',
  background: '#FBFAF7',
  foreground: '#323B35',
  card: '#FFFFFF',
  primary: '#1E3B38',
  primaryFg: '#FAF9F5',
  muted: '#F2F2EE',
  mutedFg: '#737970',
  destructive: '#B4412F',
  destructiveSoft: '#FCEDEA',
  warning: '#9A6A20',
  warningSoft: '#FAF0DA',
  success: '#3B7A64',
  successSoft: '#E6F3EE',
  corporate: '#3D5C8B',
  corporateSoft: '#EBF0F8',
  border: '#E3E4DC',
  input: '#D9DBD2',
}
export const EF = {
  heading: "'Lato', system-ui, sans-serif",
  body: "'Arvo', Georgia, serif",
  script: "'Corinthia', cursive",
  ui: "'Lato', system-ui, sans-serif",
}

// The export's three web fonts. A plain <link> rendered with the screen —
// no global stylesheet change for the rest of Bee Hub.
export function EmailsFonts() {
  return <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Arvo:wght@400;700&family=Lato:wght@300;400;700&family=Corinthia&display=swap" />
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
export function EBtn({ variant = 'secondary', style, children, ...p }) {
  const base = { display:'inline-flex', alignItems:'center', justifyContent:'center', gap:'6px', borderRadius:'8px', padding:'6px 12px', fontSize:'14px', fontWeight:500, fontFamily:EF.ui, cursor: p.disabled ? 'default' : 'pointer', opacity: p.disabled ? 0.5 : 1, border:'1px solid transparent', lineHeight:1.4, whiteSpace:'nowrap' }
  const v = {
    primary:   { background:ET.primary, color:ET.primaryFg },
    secondary: { background:ET.card, color:ET.foreground, border:`1px solid ${ET.border}` },
    ghost:     { background:'transparent', color:ET.foreground },
    danger:    { background:ET.destructive, color:'#FFFFFF' },
    dangerGhost: { background:'transparent', color:ET.destructive },
  }[variant]
  return <button type="button" {...p} style={{ ...base, ...v, ...style }}>{children}</button>
}

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

export function ESection({ id, eyebrow, title, intro, right, children, corporate }) {
  return (
    <section id={id} style={{ scrollMarginTop:'112px', borderRadius:'16px', border:`1px ${corporate ? 'dashed' : 'solid'} ${corporate ? 'rgba(61,92,139,0.3)' : ET.border}`, background:ET.card, padding:'20px 22px' }}>
      <div style={{ marginBottom:'20px', display:'flex', flexWrap:'wrap', alignItems:'flex-start', justifyContent:'space-between', gap:'12px' }}>
        <div>
          <p style={{ margin:'0 0 4px', display:'flex', alignItems:'center', gap:'8px', fontSize:'11px', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.14em', color:ET.gold, fontFamily:EF.ui }}>{eyebrow}{corporate && <CorporateTag />}</p>
          <h2 style={{ margin:0, fontSize:'20px', fontWeight:300, color:ET.foreground, fontFamily:EF.heading }}>{title}</h2>
          {intro && <p style={{ margin:'4px 0 0', maxWidth:'672px', fontFamily:EF.body, fontSize:'13px', lineHeight:1.6, color:ET.mutedFg }}>{intro}</p>}
        </div>
        {right}
      </div>
      {children}
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
      <div style={{ display:'flex', alignItems:'center', borderRadius:'8px', border:`1px solid ${shownProblem ? ET.destructive : ET.border}`, background: readOnly ? ET.muted : ET.card, boxShadow: shownProblem ? '0 0 0 1px rgba(180,65,47,0.25)' : 'none' }}>
        <input id={id} type={type} value={draft} placeholder={placeholder} readOnly={readOnly}
          onChange={e => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit() } }}
          style={{ width:'100%', background:'transparent', border:'none', outline:'none', padding:'8px 12px', fontSize:'14px', color:ET.foreground, fontFamily:EF.ui, boxSizing:'border-box' }} />
      </div>
      {shownProblem
        ? <span style={{ marginTop:'4px', display:'flex', alignItems:'center', gap:'4px', fontSize:'12px', fontWeight:500, color:ET.destructive, fontFamily:EF.ui }}>⚠ {shownProblem}</span>
        : hint && <span style={{ marginTop:'4px', display:'block', fontSize:'12px', color:ET.mutedFg, fontFamily:EF.ui }}>{hint}</span>}
    </label>
  )
}

export function UseToggle({ label, on, onChange, onText, offText, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)}
      style={{ display:'flex', alignItems:'flex-start', gap:'12px', borderRadius:'12px', border:`1px solid ${on ? 'rgba(200,154,86,0.5)' : ET.border}`, background: on ? ET.goldSoft : ET.muted, padding:'16px', textAlign:'left', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1, fontFamily:EF.ui }}>
      <span style={{ marginTop:'2px', display:'flex', height:'24px', width:'44px', flexShrink:0, alignItems:'center', borderRadius:'999px', padding:'2px', background: on ? ET.gold : 'rgba(115,121,112,0.4)', boxSizing:'border-box', transition:'background 150ms' }}>
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
      <div role="alert" style={{ borderRadius:'16px', border:`2px solid ${ET.destructive}`, background:ET.destructiveSoft, padding:'20px 22px', fontFamily:EF.ui }}>
        <div style={{ display:'flex', gap:'12px' }}>
          <span aria-hidden style={{ fontSize:'22px', lineHeight:1, color:ET.destructive }}>⛔</span>
          <div style={{ flex:1 }}>
            <h2 style={{ margin:0, fontSize:'18px', fontWeight:700, color:ET.destructive, fontFamily:EF.heading }}>No emails are going out from {locationName || 'your location'}</h2>
            <p style={{ margin:'4px 0 0', fontFamily:EF.body, fontSize:'14px', color:'rgba(50,59,53,0.8)', lineHeight:1.6 }}>Clients who get in touch aren't getting even the first thank-you, because there's no address to send from. Add your Bee Organized email address and everything starts again straight away.</p>
            {onStartSending && (
              <form onSubmit={async e => { e.preventDefault(); if (!/\S+@\S+\.\S+/.test(draft)) return; const problem = await onStartSending(draft.trim()); setErr(problem || null) }}
                style={{ marginTop:'16px', display:'flex', flexWrap:'wrap', gap:'8px' }}>
                <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="you@beeorganized.com" aria-label="Send from email"
                  style={{ flex:'1 1 220px', borderRadius:'8px', border:'1px solid rgba(180,65,47,0.4)', background:ET.card, padding:'8px 12px', fontSize:'14px', outline:'none', fontFamily:EF.ui }} />
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
      <div role="status" style={{ borderRadius:'16px', border:'2px solid rgba(154,106,32,0.5)', background:ET.warningSoft, padding:'20px 22px', fontFamily:EF.ui }}>
        <div style={{ display:'flex', gap:'12px' }}>
          <span aria-hidden style={{ fontSize:'20px', lineHeight:1, color:ET.warning }}>⏸</span>
          <div style={{ flex:1 }}>
            <h2 style={{ margin:0, fontSize:'18px', fontWeight:700, color:ET.foreground, fontFamily:EF.heading }}>{count} {count === 1 ? 'email is' : 'emails are'} waiting on you</h2>
            <p style={{ margin:'4px 0 0', fontFamily:EF.body, fontSize:'14px', color:'rgba(50,59,53,0.8)' }}>Everything else is sending. These are skipped for every client until the missing detail is filled in.</p>
            <ul style={{ listStyle:'none', padding:0, margin:'16px 0 0', display:'flex', flexDirection:'column', gap:'8px' }}>
              {held.map(h => (
                <li key={h.need} style={{ display:'flex', flexWrap:'wrap', alignItems:'center', gap:'8px', borderRadius:'12px', background:ET.card, padding:'12px' }}>
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
    <div role="status" style={{ display:'flex', alignItems:'center', gap:'12px', borderRadius:'16px', border:`1px solid ${ET.border}`, background:ET.successSoft, padding:'16px 20px', fontFamily:EF.ui }}>
      <span aria-hidden style={{ color:ET.success, fontSize:'18px' }}>✓</span>
      <p style={{ margin:0, fontSize:'14px' }}><span style={{ fontWeight:600 }}>{someOff ? `${activeCount} of ${totalCount} emails are sending` : `All ${activeCount} emails are sending`}</span> <span style={{ color:ET.mutedFg }}>from {fromEmail}</span></p>
    </div>
  )
}

export function EmailsJumpNav({ corporate }) {
  const items = [['sender', 'Sending'], ['details', 'Your details'], ['style', 'Look'], ['signature', 'Signature'], ['emails', 'The emails'], ...(corporate ? [['masters', 'Bee Organized versions']] : [])]
  return (
    <nav aria-label="On this page" style={{ position:'sticky', top:0, zIndex:30, display:'flex', gap:'4px', overflowX:'auto', borderBottom:`1px solid ${ET.border}`, background:'rgba(251,250,247,0.95)', padding:'8px 4px', backdropFilter:'blur(6px)' }}>
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
      <div role="radiogroup" aria-label="Email look" style={{ display:'grid', gridAutoFlow:'column', gridAutoColumns:'minmax(150px, 1fr)', gap:'12px', overflowX:'auto', paddingBottom:'8px' }}>
        {EMAIL_STYLES.map(s => {
          const on = current === s.id
          return (
            <button key={s.id} type="button" role="radio" aria-checked={on} disabled={!ready || saving} onClick={() => onPick(s.id)}
              style={{ minWidth:0, borderRadius:'12px', border:`2px solid ${on ? ET.gold : 'transparent'}`, background:ET.band, padding:'8px', textAlign:'left', cursor: ready ? 'pointer' : 'default', boxShadow: on ? '0 4px 10px rgba(0,0,0,0.08)' : 'none', fontFamily:EF.ui }}>
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
    <div style={{ marginTop:'16px', display:'flex', flexWrap:'wrap', alignItems:'center', gap:'8px', borderRadius:'8px', background:ET.muted, padding:'12px', fontSize:'12px', fontFamily:EF.ui }}>
      <span aria-hidden style={{ color:ET.mutedFg }}>✉</span>
      <span style={{ flex:1 }}>
        {tested ? <>Sent to <b>{state.to}</b>. Check your inbox in a minute.</>
          : state && state.err ? <span style={{ color:ET.destructive }}>{state.err}</span>
          : !sending ? 'Add a send-from address before you can send a test.'
          : !target ? 'Save this email once before sending yourself a test.'
          : 'See it exactly as a client will, in your own inbox.'}
      </span>
      <EBtn style={{ fontSize:'12px' }} disabled={!can || state === 'busy' || !!tested} onClick={send}>{tested ? 'Test sent' : state === 'busy' ? 'Sending…' : 'Send me a test'}</EBtn>
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
        <div role="group" aria-label={`Add ${what}`} style={{ marginTop:'8px', borderRadius:'12px', border:'1px solid rgba(154,106,32,0.5)', background:ET.warningSoft, padding:'12px', fontFamily:EF.ui }}>
          <label style={{ display:'block', fontSize:'13px', fontWeight:600, color:ET.foreground }}>
            {need === 'rate' ? 'Your hourly rate' : 'Your booking link'}
            <input autoFocus value={value} onChange={e => setValue(e.target.value)} placeholder={need === 'rate' ? '$85' : 'https://calendly.com/…'}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); confirm() } }}
              style={{ display:'block', marginTop:'6px', width:'100%', borderRadius:'8px', border:`1px solid ${ET.border}`, background:ET.card, padding:'8px 12px', fontSize:'14px', fontFamily:EF.ui, boxSizing:'border-box' }} />
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
          <div style={{ borderRadius:'12px', background:ET.band, padding:'16px' }}>
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
  const lab = labelStyle || { fontSize:'12px', fontWeight:600, color:'#1a2e2b', display:'block', marginBottom:'4px' }
  const inp = inputStyle || { width:'100%', padding:'8px 10px', border:'1.5px solid rgba(0,0,0,0.1)', borderRadius:'8px', fontSize:'13px', fontFamily:'inherit', color:'#1a2e2b', outline:'none', boxSizing:'border-box' }
  return (
    <div data-button-fields style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(200px, 1fr))', gap:'12px' }}>
      <label style={{ display:'block' }}>
        <span style={lab}>Button text <span style={{ fontWeight:400, color:'#8a9e9a' }}>· optional</span></span>
        <input type="text" value={text} maxLength={60} placeholder="Book a time" onChange={e => onText(e.target.value)} style={inp} />
      </label>
      <label style={{ display:'block' }}>
        <span style={lab}>Button link <span style={{ fontWeight:400, color:'#8a9e9a' }}>· optional</span></span>
        <input type="text" value={link} placeholder="{{booking_link}}" onChange={e => onLink(e.target.value)} style={inp} />
      </label>
      <p style={{ gridColumn:'1 / -1', margin:0, fontSize:'11px', color:'#8a9e9a', lineHeight:1.5 }}>
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
      <p style={{ margin:'0 0 6px', fontSize:'12px', fontWeight:600, color:'#1a2e2b' }}>Insert a detail <span style={{ fontWeight:400, color:'#8a9e9a' }}>· click where it should go, then pick one</span></p>
      {MERGE_TAG_GROUPS.map(g => {
        const inGroup = tags.filter(t => t.group === g.id)
        if (!inGroup.length) return null
        return (
          <div key={g.id} style={{ marginBottom:'6px' }}>
            <p style={{ margin:'0 0 4px', fontSize:'10px', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em', color:'#8a9e9a' }}>{g.title}</p>
            <div style={{ display:'flex', flexWrap:'wrap', gap:'5px' }}>
              {inGroup.map(t => (
                <button key={t.key} type="button" data-merge-tag={t.key} title={t.description}
                  onMouseDown={e => e.preventDefault()}   // keep the field's cursor
                  onMouseEnter={() => setHint(t)} onFocus={() => setHint(t)}
                  onClick={() => onInsert(mergeTagToken(t.key))}
                  style={{ padding:'4px 9px', borderRadius:'20px', cursor:'pointer', border:'1px solid rgba(168,201,196,0.7)', background:'rgba(168,201,196,0.14)', fontSize:'11.5px', fontFamily:'inherit', color:'#1a2e2b', fontWeight:500 }}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        )
      })}
      <p aria-live="polite" style={{ margin:'4px 0 0', minHeight:'16px', fontSize:'11.5px', color:'#4a5f5b', lineHeight:1.5 }}>
        {hint ? <><code>{mergeTagToken(hint.key)}</code> — {hint.description}</> : null}
      </p>
      <button type="button" onClick={() => setAll(a => !a)} style={{ marginTop:'2px', background:'none', border:'none', padding:0, fontSize:'11.5px', color:'#1a2e2b', textDecoration:'underline', cursor:'pointer', fontFamily:'inherit' }}>
        {all ? 'Hide what each one means' : 'What each one means'}
      </button>
      {all && (
        <dl style={{ margin:'6px 0 0', fontSize:'11.5px', lineHeight:1.5, color:'#4a5f5b' }}>
          {tags.map(t => (
            <div key={t.key} style={{ marginBottom:'4px' }}>
              <dt style={{ display:'inline', fontWeight:600, color:'#1a2e2b' }}>{t.label} <code style={{ fontWeight:400 }}>{mergeTagToken(t.key)}</code></dt>
              <dd style={{ display:'inline', margin:'0 0 0 6px' }}>{t.description}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
