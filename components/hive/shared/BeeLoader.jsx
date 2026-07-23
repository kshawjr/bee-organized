// components/hive/shared/BeeLoader.jsx
// ─────────────────────────────────────────────────────────────
// The branded loading state: a bee orbiting a honey pot (Option C).
//
// TWO THINGS HERE MATTER MORE THAN THE ANIMATION.
//
//  1. IT WAITS BEFORE APPEARING. After the Fix 2 work most screens resolve in
//     well under a second — 'All Locations' is ~0.9s, a scoped load 0.5–1.7s,
//     an overlay fetch often under 200ms. A loader that flashes up and
//     disappears reads as a GLITCH, not as progress: the eye registers
//     something happened but not what. So nothing renders until the load has
//     genuinely outlasted SHOW_AFTER_MS. A fast load shows no loader at all,
//     which is the correct outcome, not a missing one.
//
//     The delay lives HERE, not at the call sites: `{loading && <BeeLoader/>}`
//     is the natural thing to write, and it would flash on every fast load if
//     each caller had to remember its own timer. Correct by default.
//
//  2. IT RESPECTS prefers-reduced-motion. A continuous orbit is exactly the
//     kind of looping motion that triggers nausea and vestibular symptoms.
//     Under reduced motion the bee and pot render STILL — deliberately not
//     hidden, because hiding it would leave those users with no loading
//     feedback at all, which is a worse outcome than an un-animated one. The
//     caption plus role="status" carries the message instead.
//
// The animation itself is two paired CSS keyframes (ring rotates, bee
// counter-rotates so it stays upright) from the shared motion home. No JS
// loop, no rAF, no per-frame React work — transforms only, so it composites
// without a single reflow.
//
// TOKENS ONLY: the hive source sweep pins tokens.js as the sole hex/rgba home
// for components/hive/**. Every colour here resolves through T. The emoji are
// glyphs, not colour literals.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useState } from 'react'
import { T } from './tokens'
import { useReducedMotion } from './motion'

// How long a load must run before the bee is worth showing. Tuned to the
// post-Fix-2 reality: below this, a load is perceived as instant and a loader
// would be pure noise; above it, the user is waiting and deserves to be told.
// 350ms sits in the middle of the 300–400ms band where a flash stops reading
// as a glitch and starts reading as a state.
export const SHOW_AFTER_MS = 350

// Two variants. `inline` sits inside a section, rail or panel body; `screen`
// centres in a full route/overlay body with room to breathe. Same component,
// same animation — only the scale and the vertical padding differ, so a caller
// never has to hand-tune sizes.
const SIZES = {
  inline: { pot: 26, bee: 15, orbit: 22, pad: '22px 14px', gap: '9px', caption: '12px' },
  screen: { pot: 44, bee: 24, orbit: 36, pad: '56px 24px', gap: '14px', caption: '13px' },
}

const SPIN_MS = 2600

// Gate a boolean behind a delay. Returns false until `active` has been
// continuously true for `delayMs`. Resets the moment it goes false, so a
// second load starts its own clock rather than inheriting the first one's.
export function useDelayedFlag(active, delayMs = SHOW_AFTER_MS) {
  // delayMs <= 0 seeds TRUE rather than waiting for an effect. That matters
  // beyond saving a tick: app/loading.tsx is streamed as HTML before any JS
  // runs, so a false-then-effect initial state would render an EMPTY fallback
  // through the whole pre-hydration wait — precisely the wait it exists to
  // cover. Same value on server and client, so no hydration mismatch.
  const [shown, setShown] = useState(delayMs <= 0 ? !!active : false)
  useEffect(() => {
    if (!active) { setShown(false); return }
    if (delayMs <= 0) { setShown(true); return }
    const t = setTimeout(() => setShown(true), delayMs)
    return () => clearTimeout(t)
  }, [active, delayMs])
  return shown
}

export default function BeeLoader({
  label = 'Just a moment…',
  size = 'inline',
  // Escape hatch for a caller that has ALREADY waited (e.g. it knows the
  // request is slow) and wants the bee immediately. Not the default: the
  // default has to be the safe one.
  delay = SHOW_AFTER_MS,
}) {
  const reduced = useReducedMotion()
  const show = useDelayedFlag(true, delay)

  // Nothing at all before the threshold — no placeholder, no reserved box.
  // A reserved box would jump the layout on every fast load, which is the
  // flash problem wearing a different hat.
  if (!show) return null

  const s = SIZES[size] || SIZES.inline
  const ring = s.orbit * 2

  return (
    <div
      // role=status + polite: a screen reader hears "Gathering your clients…"
      // once, without stealing focus. This is the ONLY loading feedback a
      // reduced-motion or non-visual user gets, so it is not decorative.
      role="status"
      aria-live="polite"
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: s.gap, padding: s.pad, width: '100%',
        boxSizing: 'border-box',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'relative', width: `${ring}px`, height: `${ring}px`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {/* the pot — centred anchor the bee circles */}
        <span className="bee-loader-pot" style={{
          fontSize: `${s.pot}px`, lineHeight: 1, userSelect: 'none',
          animation: reduced ? undefined : `beePotBreathe ${SPIN_MS * 2}ms ease-in-out infinite`,
        }}>
          🍯
        </span>

        {/* the orbit ring — full-box, rotates about its centre. The bee is
            pushed out to the radius inside it, so one rotation carries the bee
            all the way round without any per-frame position maths. */}
        <div className="bee-loader-orbit" style={{
          position: 'absolute', inset: 0,
          animation: reduced ? undefined : `beeOrbit ${SPIN_MS}ms linear infinite`,
          // Under reduced motion the ring is static, so park the bee at a
          // pleasant resting angle instead of the 3-o'clock default.
          transform: reduced ? 'rotate(-35deg)' : undefined,
          willChange: reduced ? undefined : 'transform',
        }}>
          <span style={{
            position: 'absolute', top: '50%', left: '50%',
            // translate out to the orbit radius, then counter-rotate so the
            // bee stays upright rather than tumbling round the circle.
            transform: `translate(-50%, -50%) translateX(${s.orbit}px)`,
            fontSize: `${s.bee}px`, lineHeight: 1, userSelect: 'none',
          }}>
            <span className="bee-loader-counter" style={{
              display: 'inline-block',
              animation: reduced ? undefined : `beeOrbitCounter ${SPIN_MS}ms linear infinite`,
              transform: reduced ? 'rotate(35deg)' : undefined,
            }}>
              🐝
            </span>
          </span>
        </div>
      </div>

      {label && (
        <p style={{
          margin: 0, fontSize: s.caption, color: T.ink.muted,
          textAlign: 'center', lineHeight: 1.5, maxWidth: '260px',
        }}>
          {label}
        </p>
      )}
    </div>
  )
}
