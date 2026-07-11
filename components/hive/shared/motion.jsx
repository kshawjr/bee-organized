// components/hive/shared/motion.jsx
// ─────────────────────────────────────────────────────────────
// Close-out MOTION for the EngagementPanel — the celebratory/quiet
// flourishes that acknowledge a terminal move, plus the shared
// reduced-motion gate and the stage-move chip transition.
//
//   Won   → a light confetti burst + a "Closed won" flourish.
//   Lost  → a quick, brief sad-face acknowledgment (fast, non-lingering).
//   Reopen/any stage MOVE → the StatusChip animates so the eye SEES the
//           move land instead of a silent jump (chipMove).
//
// ACCESSIBILITY: everything here honors prefers-reduced-motion — the
// celebration collapses to a still card that fades in and out (no
// confetti, no bounce), and the chip move is skipped. useReducedMotion
// is the ONE gate; never animate without consulting it.
//
// TOKENS ONLY (the hive source-sweep pins tokens.js as the sole hex/rgba
// home): every color here resolves through T — confetti pulls the locked
// chip-family text stops, the flourish cards use surface/accent tokens.
// The @keyframes carry transforms/opacity only (no color), so they add no
// literals. PURE-ish: React + react-dom + tokens. Safe in the beta chunk.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { T } from './tokens'

// prefers-reduced-motion — SSR- and test-safe (guards missing matchMedia,
// e.g. happy-dom). Reacts live if the OS setting flips mid-session.
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduced(!!mq.matches)
    sync()
    mq.addEventListener?.('change', sync)
    return () => mq.removeEventListener?.('change', sync)
  }, [])
  return reduced
}

// One-time keyframes injection (idempotent across mounts). Color-free —
// transforms + opacity only, so no literal ever lands outside tokens.
let injected = false
export function useMotionKeyframes() {
  useEffect(() => {
    if (injected || typeof document === 'undefined') return
    const el = document.createElement('style')
    el.setAttribute('data-bee-motion', '')
    el.textContent = `
      @keyframes beeConfettiFall {
        0%   { opacity: 1; transform: translate3d(0,0,0) rotate(0deg); }
        100% { opacity: 0; transform: translate3d(var(--bee-dx,0), 112vh, 0) rotate(var(--bee-rot,360deg)); }
      }
      @keyframes beePopIn {
        0%   { opacity: 0; transform: scale(0.5) translateY(8px); }
        55%  { opacity: 1; transform: scale(1.1) translateY(0); }
        100% { opacity: 1; transform: scale(1) translateY(0); }
      }
      @keyframes beeCardIn {
        0%   { opacity: 0; transform: translateY(14px) scale(0.98); }
        100% { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes beeFadeIn { from { opacity: 0; } to { opacity: 1; } }
      @keyframes beeChipMove {
        0%   { opacity: 0; transform: translateY(-7px) scale(0.94); }
        60%  { opacity: 1; transform: translateY(0) scale(1.04); }
        100% { opacity: 1; transform: translateY(0) scale(1); }
      }
    `
    document.head.appendChild(el)
    injected = true
  }, [])
}

// The chip-move animation the masthead StatusChip wears when the stage
// changes (close, reopen, drift correction). Keyed on the stage so React
// remounts + replays; reduced-motion skips it entirely.
export function chipMoveStyle(reduced) {
  return reduced ? undefined : { animation: 'beeChipMove 0.42s cubic-bezier(0.22,1,0.36,1)', display: 'inline-flex' }
}

// Confetti palette = the locked chip-family text stops (saturated, on-brand,
// already token-homed). Index-varied so no two bursts look identical.
const CONFETTI_COLORS = [
  T.family.teal.text, T.family.blue.text, T.family.green.text,
  T.family.amber.text, T.family.red.text, T.family.purple.text,
]

// Deterministic-enough spread without leaning on a shared RNG shape: a
// cheap hash off the index gives each piece its own lane/tilt/pace.
function confettiPieces(n) {
  const pieces = []
  for (let i = 0; i < n; i++) {
    const r = (k) => {
      const x = Math.sin((i + 1) * 12.9898 * (k + 1)) * 43758.5453
      return x - Math.floor(x) // 0..1
    }
    const left = Math.round(r(1) * 100)                 // vw start
    const dx = Math.round((r(2) - 0.5) * 220)           // px drift
    const rot = 360 + Math.round(r(3) * 540)            // deg spin
    const delay = (r(4) * 0.25).toFixed(2)              // s
    const dur = (1 + r(5) * 0.7).toFixed(2)             // s
    const size = 7 + Math.round(r(6) * 6)               // px
    const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length]
    const round = r(7) > 0.5
    pieces.push({ left, dx, rot, delay, dur, size, color, round })
  }
  return pieces
}

// Celebration overlay — body-portalled, pointer-events-none, above the
// overlay layer (RecordMenu rides 10011; the scrim is 10005). Self-times
// its own dismissal via onDone; the caller just flips `kind`.
//   kind: 'won' | 'lost' | null
export function Celebration({ kind, onDone = () => {} }) {
  const reduced = useReducedMotion()
  useMotionKeyframes()
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  // A single message per mount (won is upbeat, lost is a brief nod). Fixed
  // pick — no shared RNG needed, and a stable value across re-renders.
  const [pieces] = useState(() => (reduced ? [] : confettiPieces(34)))

  useEffect(() => {
    if (!kind) return
    // Lost is deliberately FAST (a quick acknowledgment, not a dwell);
    // won lingers just long enough for the confetti to clear. Reduced
    // motion trims both to a short, still fade.
    const ms = reduced ? 650 : kind === 'won' ? 1500 : 850
    const t = setTimeout(() => doneRef.current(), ms)
    return () => clearTimeout(t)
  }, [kind, reduced])

  if (!kind || typeof document === 'undefined') return null

  const won = kind === 'won'
  const cardAnim = reduced ? 'beeFadeIn 0.2s ease forwards' : 'beeCardIn 0.32s cubic-bezier(0.22,1,0.36,1) forwards'

  return createPortal(
    <div aria-hidden="true" style={{
      position: 'fixed', inset: 0, zIndex: 10020, pointerEvents: 'none', overflow: 'hidden',
    }}>
      {/* confetti — won only, motion only. Transform/opacity only → GPU
          cheap, no reflow, safe on mobile. */}
      {won && pieces.map((p, i) => (
        <span key={i} style={{
          position: 'absolute', top: '-6vh', left: `${p.left}vw`,
          width: `${p.size}px`, height: `${p.size}px`, background: p.color,
          borderRadius: p.round ? '50%' : '2px',
          // custom props consumed by the keyframe
          ['--bee-dx']: `${p.dx}px`, ['--bee-rot']: `${p.rot}deg`,
          animation: `beeConfettiFall ${p.dur}s ${p.delay}s cubic-bezier(0.4,0,0.7,1) forwards`,
          willChange: 'transform, opacity',
        }} />
      ))}
      {/* the flourish card — centered, brief. Emoji is the whole message;
          copy stays minimal so it never reads as a modal. */}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
        <div style={{
          background: T.surface.raised, border: T.border.card, borderRadius: T.radius.card,
          boxShadow: T.shadow.overlay, padding: '22px 30px', textAlign: 'center', maxWidth: '260px',
          animation: cardAnim,
        }}>
          <div style={{
            fontSize: '64px', lineHeight: 1, marginBottom: '8px',
            animation: reduced ? undefined : 'beePopIn 0.5s cubic-bezier(0.22,1.4,0.4,1) forwards',
          }}>
            {won ? '🎉' : '😔'}
          </div>
          <div style={{ fontSize: '14px', fontWeight: 700, color: won ? T.accent.deep : T.ink.secondary }}>
            {won ? 'Closed won!' : 'Closed lost'}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
