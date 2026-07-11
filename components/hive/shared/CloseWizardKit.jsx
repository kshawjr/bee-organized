// components/hive/shared/CloseWizardKit.jsx
// ─────────────────────────────────────────────────────────────
// Shared chrome for the close-out wizards (Lost 2-step, Won 4-step):
//   · WizardStepper — the numbered progress rail. Completed steps FILL
//     with the accent green + a check; the current step raises with an
//     accent ring; not-yet steps are hollow muted. The "animation" is a
//     pure CSS transition on the node fill/color as a step completes —
//     no confetti lib, just the stepper flowing green (Kevin's ask).
//   · WizardShell — title + stepper + body + footer inside OverlayShell
//     (desktop modal / mobile sheet — the blessed overlay chrome).
//   · segBtn / primaryBtn / quietBtn — the wizard's shared controls.
//
// tokens.js only. Beta chunk.
// ─────────────────────────────────────────────────────────────
'use client'

import React from 'react'
import OverlayShell from '../OverlayShell'
import { IconCheck } from '@/components/ui/icons'
import { T } from './tokens'

// steps: array of { key, label }; current is a 0-based index.
export function WizardStepper({ steps = [], current = 0 }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '0 2px' }}>
      {steps.map((s, i) => {
        const done = i < current
        const active = i === current
        return (
          <React.Fragment key={s.key}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 }}>
              <span
                aria-label={done ? `${s.label} done` : active ? `${s.label} current` : `${s.label} upcoming`}
                data-wizard-node={done ? 'done' : active ? 'current' : 'future'}
                style={{
                  width: '22px', height: '22px', borderRadius: T.radius.round, flexShrink: 0,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '11px', fontWeight: 600, fontVariantNumeric: T.type.tabular,
                  boxSizing: 'border-box',
                  // The green-fill transition — completing a step animates
                  // the node from hollow/ring to a solid accent fill.
                  transition: 'background 260ms ease, border-color 260ms ease, color 260ms ease',
                  background: done ? T.accent.fg : T.surface.raised,
                  border: done ? `2px solid ${T.accent.fg}` : active ? `2px solid ${T.accent.fg}` : `1.5px solid ${T.hairline.strong}`,
                  color: done ? T.accent.onFill : active ? T.accent.deep : T.ink.quiet,
                }}>
                {done ? <IconCheck size={12} /> : i + 1}
              </span>
              <span style={{
                fontSize: '11px', fontWeight: 500, whiteSpace: 'nowrap',
                color: active ? T.ink.primary : done ? T.accent.deep : T.ink.quiet,
                transition: 'color 260ms ease',
              }}>
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <span aria-hidden style={{
                flex: 1, minWidth: '10px', height: '1px',
                background: i < current ? T.accent.fg : T.hairline.line,
                transition: 'background 260ms ease',
              }} />
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}

// The wizard container: OverlayShell + a padded title/stepper/body/footer
// column. footer is a node the caller composes (Back/Next/confirm).
export function WizardShell({ isMobile, onClose, title, steps = null, current = 0, children, footer, maxWidth = 520 }) {
  return (
    <OverlayShell isMobile={isMobile} onClose={onClose} maxWidth={maxWidth}>
      <div style={{ padding: isMobile ? '0 16px 18px' : '0 24px 22px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <h2 style={{ fontSize: '17px', fontWeight: 600, color: T.ink.primary, letterSpacing: T.type.trackTitle }}>{title}</h2>
        {steps && <WizardStepper steps={steps} current={current} />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>{children}</div>
        {footer && (
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', alignItems: 'center', marginTop: '2px' }}>
            {footer}
          </div>
        )}
      </div>
    </OverlayShell>
  )
}

export const wizPrimaryBtn = (disabled = false) => ({
  padding: '9px 16px', borderRadius: T.radius.control, border: 'none',
  background: disabled ? T.ink.disabled : T.ink.primary, color: T.ink.inverse,
  fontSize: '13px', fontWeight: 500, fontFamily: 'inherit',
  cursor: disabled ? 'default' : 'pointer',
})

export const wizAccentBtn = (disabled = false) => ({
  padding: '9px 16px', borderRadius: T.radius.control, border: 'none',
  background: disabled ? T.ink.disabled : T.accent.fg, color: T.accent.onFill,
  fontSize: '13px', fontWeight: 500, fontFamily: 'inherit',
  cursor: disabled ? 'default' : 'pointer',
})

export const wizQuietBtn = () => ({
  padding: '9px 14px', borderRadius: T.radius.control, border: 'none',
  background: 'transparent', color: T.ink.muted,
  fontSize: '13px', fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer',
})

export const wizInput = () => ({
  padding: '9px 11px', border: T.border.control, borderRadius: T.radius.control,
  fontSize: '13px', fontFamily: 'inherit', outline: 'none', background: T.surface.raised,
  width: '100%', boxSizing: 'border-box', color: T.ink.primary,
})

// A choice segment (Lost/Won reason toggles, happy/unhappy, yes/no).
export const wizSeg = (selected, disabled = false) => ({
  flex: 1, padding: '9px 10px', borderRadius: T.radius.control,
  fontSize: '13px', fontWeight: 500, fontFamily: 'inherit',
  cursor: disabled ? 'default' : 'pointer',
  border: `0.5px solid ${selected && !disabled ? T.hairline.strong : T.hairline.line}`,
  background: selected && !disabled ? T.surface.raised : 'transparent',
  color: disabled ? T.ink.faint : (selected ? T.ink.primary : T.ink.muted),
})

export const wizLabel = (children) => (
  <p style={{ fontSize: '11px', fontWeight: 500, color: T.ink.muted, letterSpacing: '0.6px', textTransform: 'uppercase' }}>{children}</p>
)
