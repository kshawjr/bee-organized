// components/settings/ConnectionScreen.jsx
// ─────────────────────────────────────────────────────────────
// The look of a single connection's screen (Settings › Connections › Slack,
// › Jobber), to Kevin's Lovable design — the export's
// src/components/settings/ConnectionDetails.tsx (2026-11-25).
//
// LOOK ONLY. These are the pieces the screen is drawn with: the frame (name,
// who it is linked to, one status chip), a titled area, a warning box, a
// number tile, a progress bar, the quiet links at the foot, and the "are you
// sure" window. Nothing here fetches, saves, connects or disconnects — every
// action is a function handed in by SlackCard / JobberCard in BeeHub.jsx,
// which are the same functions those cards always called.
//
// DISCONNECT IS A QUIET TEXT LINK at the foot, under a rule. Never a button
// (Kevin, 2026-11-25). <ConnFooter> is the only place it is drawn.
//
// The design's row of preview pills ("Not connected · Connected · Channel
// broken") is a design-tool control for flipping between sample states. It
// is not part of the screen and is not built.
// ─────────────────────────────────────────────────────────────
'use client'

import React from 'react'
import { T, R, FONT, SHADOW, alpha } from '@/components/design/tokens'
import { Pill, Btn, IconAlertTriangle } from '@/components/settings/SettingsShell'

// Phone first: the chip drops under the name; from 640px it sits to the right.
const CSS = `
[data-conn-head]{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;column-gap:12px;row-gap:8px}
[data-conn-head]>[data-conn-chip]{grid-column:1 / -1;justify-self:start}
[data-conn-metrics]{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
[data-conn-quiet]:not(:disabled):hover>span{text-decoration:underline}
[data-conn-quiet]:disabled{opacity:.5;cursor:default}
@keyframes connSlide{0%{left:-30%}100%{left:100%}}
@media (min-width:640px){
[data-conn-head]{grid-template-columns:auto minmax(0,1fr) auto;column-gap:16px}
[data-conn-head]>[data-conn-chip]{grid-column:auto;justify-self:end}
[data-conn-metrics]{grid-template-columns:repeat(2,minmax(0,1fr))}
}`

export const mutedText = { fontFamily: FONT.ui, fontSize: '14px', lineHeight: 1.625, color: T.mutedFg, margin: 0 }
export const strongText = { fontFamily: FONT.ui, fontSize: '14px', lineHeight: '20px', fontWeight: 700, color: T.foreground, margin: 0 }

// ── The frame ─────────────────────────────────────────────────────────────
//   service  "Slack"                    mark    the 48px logo tile
//   place    the location's name        account "Workspace · Bee Organized"
//   status   the chip's words           tone    'ok' | 'warn' | 'own' | 'quiet'
//   intro    one line under the name    footer  <ConnFooter>, or nothing
export function ConnFrame({ service, mark, place, account, status, tone = 'ok', intro, footer, children, ...rest }) {
  return (
    <div data-conn-screen {...rest} style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <style>{CSS}</style>
      <header>
        <h1 style={{ fontSize: '30px', lineHeight: '36px', fontWeight: 300, color: T.primary, fontFamily: FONT.heading, margin: 0 }}>{service}</h1>
        {intro && <p style={{ marginTop: '4px', fontFamily: FONT.body, fontSize: '14px', lineHeight: '20px', color: T.mutedFg }}>{intro}</p>}
      </header>
      <div data-conn-head style={{ borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, padding: '20px 0' }}>
        {mark}
        <div style={{ minWidth: 0 }}>
          <p data-conn-place style={{ fontSize: '16px', lineHeight: '24px', fontWeight: 700, color: T.primary, margin: 0, overflowWrap: 'anywhere' }}>{place || service}</p>
          {account && <p data-conn-account style={{ marginTop: '4px', fontSize: '14px', lineHeight: '20px', color: T.mutedFg, overflowWrap: 'anywhere' }}>{account}</p>}
        </div>
        <Pill tone={tone} data-conn-chip data-conn-tone={tone}>
          <span aria-hidden="true" style={{ width: '6px', height: '6px', borderRadius: R.full, background: 'currentColor' }} />{status}
        </Pill>
      </div>
      <div data-conn-body style={{ minWidth: 0 }}>{children}</div>
      {footer}
    </div>
  )
}

// A titled part of the screen. A rule under each but the last.
export function Area({ title, last, children, ...rest }) {
  return (
    <section data-conn-area {...rest} style={{ minWidth: 0, padding: '24px 0', borderBottom: last ? 'none' : `1px solid ${T.border}` }}>
      <h2 style={{ marginBottom: '16px', fontFamily: FONT.body, fontSize: '20px', lineHeight: '28px', fontWeight: 400, color: T.primary }}>{title}</h2>
      {children}
    </section>
  )
}

// One line of words in a meaning's colour: 'ok' (it worked), 'danger' (it
// did not), 'warn', or 'ink' (plain, full-strength). Lets a caller say
// something coloured without holding the colours itself.
const SAY = { ok: T.success, danger: T.destructive, warn: T.warning, ink: T.foreground, muted: T.mutedFg }
export function Say({ tone = 'muted', small, strong, style, children, ...rest }) {
  return <p {...rest} style={{ fontFamily: FONT.ui, fontSize: small ? '13px' : '14px', lineHeight: small ? 1.5 : 1.625, fontWeight: strong ? 700 : 400, color: SAY[tone] || SAY.muted, margin: 0, ...style }}>{children}</p>
}

// The warning box: a triangle, one bold line, then what to do about it.
export function ConnNotice({ title, children, ...rest }) {
  return (
    <div data-conn-notice role="status" {...rest} style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', borderRadius: R.md, border: `1px solid ${alpha(T.warning, 0.25)}`, background: T.warningSoft, padding: '16px', color: T.warning, fontFamily: FONT.ui }}>
      <IconAlertTriangle size={20} style={{ flexShrink: 0, marginTop: '2px' }} />
      <div style={{ minWidth: 0, fontSize: '14px', lineHeight: 1.625, overflowWrap: 'anywhere' }}>
        <p style={{ fontWeight: 700, margin: 0 }}>{title}</p>
        {children}
      </div>
    </div>
  )
}

export function Metrics({ children }) {
  return <dl data-conn-metrics style={{ margin: 0 }}>{children}</dl>
}
export function Metric({ value, label, ...rest }) {
  return (
    <div {...rest} style={{ borderRadius: R.lg, border: `1px solid ${T.border}`, background: T.card, padding: '20px', minWidth: 0 }}>
      <dt style={{ fontSize: '12px', lineHeight: '16px', color: T.mutedFg }}>{label}</dt>
      <dd style={{ margin: '12px 0 0', fontSize: '24px', lineHeight: '32px', fontWeight: 400, color: T.primary, overflowWrap: 'anywhere' }}>{value}</dd>
    </div>
  )
}

// A bar that fills (value of max), or — when the numbers are not known yet —
// one that slides, so "0 of ?" is never on screen looking frozen.
export function Progress({ value, max, label }) {
  const known = typeof value === 'number' && typeof max === 'number' && max > 0
  const pct = known ? Math.min(100, Math.max(0, Math.round((value / max) * 100))) : null
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={known ? max : undefined} aria-valuenow={known ? value : undefined} data-conn-progress={known ? 'known' : 'waiting'}
      style={{ position: 'relative', height: '8px', width: '100%', overflow: 'hidden', borderRadius: R.full, background: T.muted }}>
      {known
        ? <div style={{ height: '100%', width: `${pct}%`, borderRadius: R.full, background: T.primary, transition: 'width .2s ease' }} />
        : <div style={{ position: 'absolute', top: 0, bottom: 0, width: '30%', borderRadius: R.full, background: T.sage, animation: 'connSlide 1.4s ease-in-out infinite' }} />}
    </div>
  )
}

// A text link: muted, no box, underlined on hover. 44px tall so it can be
// tapped. This is what Disconnect is.
export function QuietLink({ children, ...rest }) {
  return (
    <button type="button" data-conn-quiet {...rest}
      style={{ display: 'inline-flex', alignItems: 'center', minHeight: '44px', padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: FONT.ui }}>
      <span style={{ fontSize: '14px', lineHeight: '20px', fontWeight: 400, color: T.mutedFg }}>{children}</span>
    </button>
  )
}

// The foot of the screen: a rule, then the quiet links. `note` is a line of
// small print over the links for anything the owner should know first.
export function ConnFooter({ note, children }) {
  return (
    <footer data-conn-footer style={{ borderTop: `1px solid ${T.border}`, paddingTop: '12px' }}>
      {note && <p data-conn-footnote style={{ ...mutedText, fontSize: '13px', lineHeight: 1.5, margin: '4px 0 4px', maxWidth: '672px' }}>{note}</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '20px' }}>{children}</div>
    </footer>
  )
}

// "Disconnect from Slack?" — the window the Disconnect link opens. The same
// two answers, and the same words, as before.
export function ConfirmWindow({ title, children, error, busy, confirmLabel, busyLabel, onCancel, onConfirm }) {
  return (
    <div data-settings-ui data-conn-confirm style={{ position: 'fixed', inset: 0, zIndex: 10100, background: alpha(T.foreground, 0.45), display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', fontFamily: FONT.ui }}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}
        style={{ background: T.card, borderRadius: R.xl, padding: '20px', maxWidth: '360px', width: '100%', boxShadow: SHADOW.dialog }}>
        <p style={{ fontSize: '16px', lineHeight: '24px', fontWeight: 700, color: T.foreground, margin: '0 0 8px' }}>{title}</p>
        <p style={{ ...mutedText, fontSize: '13px', lineHeight: 1.55, marginBottom: '16px' }}>{children}</p>
        {error && <p role="alert" style={{ fontSize: '13px', lineHeight: 1.5, color: T.destructive, margin: '0 0 12px' }}>Couldn&apos;t disconnect: {error}</p>}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <Btn onClick={onCancel} disabled={busy}>Cancel</Btn>
          <Btn variant="danger" onClick={onConfirm} disabled={busy}>{busy ? busyLabel : confirmLabel}</Btn>
        </div>
      </div>
    </div>
  )
}
