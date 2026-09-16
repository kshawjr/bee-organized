// components/hive/shared/menuType.js
// ─────────────────────────────────────────────────────────────
// THE LEAD MENU'S TYPE HIERARCHY — one source, spent by both menus (the
// Inbox row menu and the client card's) so they cannot drift apart. They
// already share their WORDS (leadDispositions); this is the other half.
//
// THE PROBLEM. cd03c92 put a section heading above each group and a
// description under every item — three levels of type in a small menu — and
// the actions stopped popping: the thing you are CHOOSING competed with the
// thing explaining it.
//
// THE ORDERING, made visible. The label is the choice; everything else is
// support:
//   label        heaviest, darkest   — where the eye lands first
//   description  lighter, secondary  — it explains, it is not an option
//   heading      quietest            — it orients, it is not an option either
//
// WEIGHT AND COLOUR, NOT SIZE. The menu already grew when descriptions
// landed, and a taller menu on a dense worklist is its own problem, so every
// size below is UNCHANGED from cd03c92. What changed:
//   · the label went 500 → 600. It already sat on T.ink.primary, the darkest
//     ink there is, so weight was the only lever left — and it is the right
//     one: heavier reads as "this is the thing" without taking a pixel more.
//   · the description takes an explicit 400. It inherited the button's
//     default before, which happened to be 400; stating it makes the
//     two-step against the label deliberate rather than incidental.
//   · the heading went 600 → 500 and T.ink.muted → T.ink.faint.
//
// THE HEADING WAS DARKER THAN THE DESCRIPTION, which is backwards and is a
// large part of why the rows read flat: on the ink scale in tokens.js,
// T.ink.muted sits one step DARKER than T.ink.quiet, so the orienting label
// was out-ranking the explanation beneath it. The ladder now runs
// primary → quiet → faint, so the three levels descend in the order they
// matter. No new token was needed; faint is the existing lightest text tier.
//
// THE 16px FLOOR, and why this reaches the browser. globals.css line 4 is
// `input,select,button,textarea{…font-size:16px!important…}` — an iOS
// zoom-on-focus guard. It matches the BUTTON element, so a fontSize set on
// the row itself is discarded. Every size here therefore lives on a SPAN
// inside the button, which never matches that selector and keeps its own
// inline size. That is not a theory: the 11.5px descriptions shipped in
// cd03c92 render at 11.5px on Kevin's screen, which is the whole reason he
// could see they were competing. The rule for anyone editing this: put type
// on the spans, never on the button, and never reach for .bee-small-action
// here — that class would force all three levels to one size.
//
// PURE: tokens only, no React, and no raw colour value anywhere — in the
// code or in these comments. Every colour below names a tier that already
// exists on T.ink / T.state.
// ─────────────────────────────────────────────────────────────
import { T } from './tokens'

// The row's own box. Deliberately carries NO fontSize — see the floor note.
export const menuRowBox = {
  display: 'block', width: '100%',
  padding: '7px 10px', border: 'none', background: 'transparent',
  borderRadius: T.radius.control, fontFamily: 'inherit',
  cursor: 'pointer', textAlign: 'left',
}

// The label: the choice itself. DANGER COLOUR LANDS HERE and nowhere else in
// the row — a red verb tells you what this does; a red description would
// shout the explanation at you, which is not the part that needs urgency.
export const menuLabelType = (danger = false) => ({
  display: 'flex', alignItems: 'center', gap: '7px',
  fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap',
  color: danger ? T.state.danger.strong : T.ink.primary,
})

// The description: support. Always neutral, including under a destructive
// label — see above.
export const menuDescriptionType = {
  display: 'block', marginTop: '2px',
  fontSize: '11.5px', fontWeight: 400, lineHeight: 1.4,
  color: T.ink.quiet, whiteSpace: 'normal', maxWidth: '30ch',
}

// The section heading: quietest of the three. Small, uppercase and tracked
// so it still reads as a divider rather than an option — 500 rather than 400
// because uppercase at this size goes weak and hard to read at 400, and the
// lightest ink plus the size already carry "quiet".
export const menuHeadingType = {
  padding: '7px 10px 3px',
  fontSize: '10.5px', fontWeight: 500,
  letterSpacing: '0.6px', textTransform: 'uppercase',
  color: T.ink.faint,
}

// The armed confirmation's prompt. NEUTRAL, even for a destructive action:
// the red belongs on the verb the person is about to press ("Yes, mark as
// Junk", which takes menuLabelType(true) like any other danger row), not on
// the sentence explaining it. Same principle as the description above.
export const menuConfirmPromptType = {
  padding: '4px 10px 6px',
  fontSize: '11.5px', fontWeight: 400, lineHeight: 1.45,
  color: T.ink.secondary, whiteSpace: 'normal', maxWidth: '32ch',
}
