'use client'

// issue 168 — viewport-centering shell + celebration for the onboarding pay modals.
// issue 170 — the same shell now also wraps the pricing, pay_confirm and
// stripe_wait steps (via the `scroll` variant, which carries the full-height
// pay page rather than a short modal card).
//
// CENTERING. The pay screens render inside the DashboardScreen content column
// (.bee-main), which app/globals.css offsets by margin-left:220px on desktop to
// clear the fixed 220px sidebar. Their inner cards use margin:0 auto, so they
// centre within that OFFSET column — 110px right of true centre, with the
// sidebar sitting beside them. ViewportCenteredOverlay portals the layer to
// document.body, OUTSIDE .bee-main, so the inner centering is measured against
// the whole viewport (not the offset column) and the layer paints over the
// sidebar.
//
// NOTE (corrected issue 170): the earlier version of this comment blamed a
// transformed onboarding ancestor for confining position:fixed to the content
// column. That was WRONG — scout 169 checked globals.css and app/layout.tsx and
// there is no transform / filter / perspective / contain anywhere in this
// ancestry, so position:fixed already resolves against the viewport. The portal
// is still the right tool, but for a plainer reason: it lifts the layer OUT of
// the 220px-offset content column so the whole branded page (and the margin:0
// auto cards inside it) is laid out against the full viewport instead of the
// column. Escaping the offset — not defeating a containing block — is the job.
//
// We portal rather than remove the sidebar because the sidebar is NOT pure
// decoration during onboarding — Back Office stays reachable (issue 140) and
// Home returns to the wizard — so it must survive in the DOM behind the layer,
// not be display:none'd out.
//
// CELEBRATION. PayConfirmedCelebration is a CSS-only confetti burst — no new
// dependency. It is pointer-events:none and sits BEHIND the modal card, so it never
// delays or obstructs the Continue Setup button. It runs ~2.4s then settles (fades
// out). Under prefers-reduced-motion it renders NOTHING — no motion for anyone who
// has that set — gated by the shared useReducedMotion hook.

import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useReducedMotion } from '@/components/hive/shared/motion'

// Portal to <body> so the fixed layer escapes the 220px-offset content column
// (.bee-main) and is laid out against the viewport. Mount-guarded so SSR / first
// paint emit nothing (no hydration mismatch), matching the client-only nature of
// the pay flow — this mount gate is also what lets BeeHub's payStep lazy
// initialiser read the Stripe-return marker without a mismatch (issue 170): the
// server and the first client render both emit null here regardless of payStep.
//
// `scroll` (issue 170): the default is a flex-centred modal shell for a short
// card. A full-height page (pricing) would have its top clipped by
// align-items:center, so `scroll` swaps to a top-anchored, vertically-scrollable
// block instead; the page's own margin:0 auto still centres its cards against the
// now-full-viewport layer.
export function ViewportCenteredOverlay({
  children,
  backdrop = 'rgba(26,46,43,0.55)',
  padding = '12px',
  zIndex = 100,
  scroll = false,
}: {
  children: React.ReactNode
  backdrop?: string
  padding?: string | number
  zIndex?: number
  scroll?: boolean
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  if (!mounted || typeof document === 'undefined') return null
  return createPortal(
    <div
      data-pay-modal-overlay=""
      style={{
        position: 'fixed', inset: 0, zIndex,
        ...(scroll
          ? { display: 'block', overflowY: 'auto' }
          : { display: 'flex', alignItems: 'center', justifyContent: 'center' }),
        background: backdrop, padding,
      }}
    >
      {children}
    </div>,
    document.body,
  )
}

// On-brand confetti palette (Bee Organized golds + sage + deep green). Raw hex is
// fine here — this module lives in lib/, not the token-only components/hive tree.
const CONFETTI_COLORS = ['#d4a046', '#e8c060', '#a8c9c4', '#1a2e2b', '#f0b429', '#c98a2b']

// Deterministic per-piece spread from an index hash — no Math.random (so no
// hydration skew) and no shared RNG dependency. Mirrors the hive Celebration.
function confettiPieces(n: number) {
  const out = []
  for (let i = 0; i < n; i++) {
    const r = (k: number) => {
      const x = Math.sin((i + 1) * 12.9898 * (k + 1)) * 43758.5453
      return x - Math.floor(x) // 0..1
    }
    out.push({
      left: Math.round(r(1) * 100),          // vw lane
      dx: Math.round((r(2) - 0.5) * 180),    // px horizontal drift
      rot: 360 + Math.round(r(3) * 480),     // deg spin
      delay: +(r(4) * 0.35).toFixed(2),      // s stagger
      dur: +(1.7 + r(5) * 0.8).toFixed(2),   // s fall time
      size: 7 + Math.round(r(6) * 5),        // px
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      round: r(7) > 0.5,
    })
  }
  return out
}

// The celebration itself. Absolutely fills the overlay behind the card (zIndex 0),
// never intercepts a click (pointer-events:none) — so Continue Setup is live from
// the first frame — and renders NOTHING under prefers-reduced-motion.
export function PayConfirmedCelebration() {
  const reduced = useReducedMotion()
  if (reduced) return null
  const pieces = confettiPieces(24)
  return (
    <div
      aria-hidden="true"
      data-pay-celebration=""
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 0 }}
    >
      <style>{`
        @keyframes payConfettiFall {
          0%   { opacity: 0; transform: translate3d(0, -8vh, 0) rotate(0deg); }
          10%  { opacity: 1; }
          85%  { opacity: 1; }
          100% { opacity: 0; transform: translate3d(var(--pay-dx,0), 108vh, 0) rotate(var(--pay-rot,360deg)); }
        }
        /* Belt-and-suspenders with the useReducedMotion gate above. The hook
           returns false on the first render (it flips in an effect, after paint),
           so a reduced-motion user could otherwise see one painted frame. This
           browser-evaluated guard hides the whole layer immediately — zero motion,
           zero flash — independent of effect timing. */
        @media (prefers-reduced-motion: reduce) {
          [data-pay-celebration] { display: none !important; }
          .pay-confetti-piece { display: none !important; animation: none !important; }
        }
      `}</style>
      {pieces.map((p, i) => (
        <span
          key={i}
          className="pay-confetti-piece"
          style={{
            position: 'absolute', top: 0, left: `${p.left}vw`,
            width: `${p.size}px`,
            height: `${p.round ? p.size : Math.round(p.size * 0.55)}px`,
            background: p.color,
            borderRadius: p.round ? '50%' : '1px',
            ['--pay-dx' as string]: `${p.dx}px`,
            ['--pay-rot' as string]: `${p.rot}deg`,
            animation: `payConfettiFall ${p.dur}s ${p.delay}s cubic-bezier(0.35,0,0.5,1) forwards`,
            willChange: 'transform, opacity',
          } as React.CSSProperties}
        />
      ))}
    </div>
  )
}
