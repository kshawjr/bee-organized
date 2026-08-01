'use client'

// issue 168 — viewport-centering shell + celebration for the onboarding pay modals.
//
// CENTERING. The pay modals render inside the DashboardScreen content column
// (.bee-main, offset right of the 220px desktop sidebar). Their overlay is
// position:fixed; inset:0, which SHOULD span the viewport — but a transformed
// onboarding ancestor establishes a containing block that confines the fixed
// overlay to the content column. The card then sits right of true centre with the
// greyed, non-interactive sidebar as a dead column beside it. ViewportCenteredOverlay
// portals the overlay to document.body, so the viewport (not the transformed
// ancestor) becomes its containing block: it centres on the whole screen and paints
// over the sidebar, regardless of which ancestor is transformed.
//
// We centre against the viewport rather than hiding the sidebar because the sidebar
// is NOT pure decoration during onboarding — Back Office stays deliberately clickable
// (issue 140) and Home returns to the wizard, so removing it would strand both.
//
// CELEBRATION. PayConfirmedCelebration is a CSS-only confetti burst — no new
// dependency. It is pointer-events:none and sits BEHIND the modal card, so it never
// delays or obstructs the Continue Setup button. It runs ~2.4s then settles (fades
// out). Under prefers-reduced-motion it renders NOTHING — no motion for anyone who
// has that set — gated by the shared useReducedMotion hook.

import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useReducedMotion } from '@/components/hive/shared/motion'

// Portal to <body> so the fixed overlay escapes any transformed onboarding ancestor
// and centres on the viewport. Mount-guarded so SSR / first paint emit nothing
// (no hydration mismatch), matching the client-only nature of the pay flow.
export function ViewportCenteredOverlay({
  children,
  backdrop = 'rgba(26,46,43,0.55)',
  padding = '12px',
  zIndex = 100,
}: {
  children: React.ReactNode
  backdrop?: string
  padding?: string | number
  zIndex?: number
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  if (!mounted || typeof document === 'undefined') return null
  return createPortal(
    <div
      data-pay-modal-overlay=""
      style={{
        position: 'fixed', inset: 0, zIndex,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
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
