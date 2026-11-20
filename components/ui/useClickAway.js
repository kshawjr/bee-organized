// components/ui/useClickAway.js
// ─────────────────────────────────────────────────────────────
// Close a LIGHTWEIGHT menu when the person clicks or taps anywhere else.
//
// THE LINE (Kevin, 2026-11-19). Bee Hub's 2026-09-30 rule (75363e9) stopped
// everything closing on an outside click, because people were clicking out of
// things and losing what they had typed (43e72f6: a stray click beside a
// record closed it and dropped a half-typed note). That reason still holds,
// so the rule keeps a boundary instead of retiring:
//
//   CLOSES ON A CLICK AWAY: anything that holds nothing a person typed and no
//   choice waiting to be confirmed. Filter menus; pickers where a tap applies
//   straight away; the ··· menus; the account, location and profile menus;
//   the Settings dropdowns.
//
//   CLOSES ONLY BY ITS OWN BUTTONS: every pop-up window and sheet, anything
//   holding typing, and any "are you sure?" step, including one shown inside
//   a ··· menu (pass `active` false while it is showing).
//
// This hook is the ONLY place in components/ or app/ allowed a document
// pointer listener. lib/beta-no-outside-close.test.tsx enforces that, and
// names every component allowed to call it, so the rule cannot spread to a
// window or sheet without a test failing and a reason being written in.
//
// How it closes: a pointer press anywhere outside `isInside` calls onAway.
// The press itself carries on to whatever it landed on. Pressing inside (the
// menu, or the button that opens it) is left alone, so that button still
// toggles it shut. onAway must only close: never pick, save or clear.
// ─────────────────────────────────────────────────────────────
'use client'

import { useEffect, useRef } from 'react'

/**
 * @param {boolean} active      listen only while the menu is open (and not asking "are you sure?")
 * @param {() => void} onAway   close the menu, nothing else
 * @param {(target: Node) => boolean} isInside  true for a press on the menu or its own button
 */
export function useClickAway(active, onAway, isInside) {
  const away = useRef(onAway)
  const inside = useRef(isInside)
  away.current = onAway
  inside.current = isInside
  useEffect(() => {
    if (!active) return undefined
    const press = (e) => {
      const t = e.target
      if (t && typeof t === 'object' && 'nodeType' in t && inside.current(t)) return
      away.current()
    }
    // Capture phase, so nothing on the page can swallow the press first.
    document.addEventListener('pointerdown', press, true) // click-away: lightweight menus only (Kevin, 2026-11-19)
    return () => document.removeEventListener('pointerdown', press, true)
  }, [active])
}

/** isInside for a menu whose button and list sit inside these elements. */
export const insideRefs = (...refs) => (t) => refs.some((r) => !!r?.current && r.current.contains(t))
