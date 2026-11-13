// components/design/tokens.js
// ─────────────────────────────────────────────────────────────
// THE colours, corners, shadows and fonts of the new Bee Hub look (Kevin's
// Lovable design). One copy, for every module rebuilt to it.
//
// Source: the export's src/styles.css `:root` (Settings export, 2026-11-13).
// The export states its colours as oklch(); Bee Hub writes inline style
// objects, so they are converted to hex ONCE, here. Settings → Emails was the
// first screen rebuilt (2026-10-30) and carries its own copy of this table
// (ET / ER / ESHADOW / EF in components/settings/EmailsScreen.jsx). That was
// right for one screen; eight modules each copying it would drift. From the
// Settings shell on, a rebuilt screen imports this file and declares no
// colour of its own. lib/design-tokens.test.ts holds the Emails copy equal to
// this one until it is folded in.
//
// PURE and zero-import, like components/ui/tokens.js — safe in any bundle.
//
// Not the same thing as the two older token files, which are untouched:
//   components/ui/tokens.js           text, hairline and green stops for the
//                                     beta surfaces (contrast-tested)
//   components/hive/shared/tokens.js  the hive cards' surface/ink/accent set
// Those describe TODAY's look. When a module they serve is rebuilt, its
// values come from here instead and its entries there retire; once nothing
// imports them they can be deleted. Until then both stay as they are.
//
// The hex beside each name is the exact conversion of the oklch() value in
// the trailing comment. The export's own comments round two of them
// differently (gold "#C89A56", sage "#A8C9C4"): the oklch() is what its
// browser paints, so the oklch() is what is matched.
// ─────────────────────────────────────────────────────────────

export const T = {
  // Brand, measured from beeorganized.com
  ink:            '#595C57', // oklch(0.47 0.008 130)
  gold:           '#C69856', // oklch(0.71 0.1 75)
  goldSoft:       '#F9EDD9', // oklch(0.95 0.03 80)
  sage:           '#A2C7C1', // oklch(0.8 0.04 185)
  sageSoft:       '#E4F2F0', // oklch(0.95 0.015 185)
  band:           '#F5F5F5', // oklch(0.97 0 0)

  // Surfaces and text
  background:     '#FBFAF8', // oklch(0.985 0.003 90)
  foreground:     '#2A302B', // oklch(0.3 0.012 150)
  card:           '#FFFFFF', // oklch(1 0 0)
  popover:        '#FFFFFF', // oklch(1 0 0)
  primary:        '#1A302C', // oklch(0.29 0.03 180)
  primaryFg:      '#FAF8F5', // oklch(0.98 0.005 90)
  secondary:      '#F1F3ED', // oklch(0.96 0.008 120)
  muted:          '#F2F2EE', // oklch(0.96 0.006 110)
  mutedFg:        '#676A64', // oklch(0.52 0.01 130)
  // accent = sageSoft, accent text = primary (aliases in the export)

  // Meaning
  destructive:    '#B6322B', // oklch(0.52 0.17 28)
  destructiveSoft:'#FFEBE7', // oklch(0.96 0.03 28)
  destructiveFg:  '#FCFCFC', // oklch(0.99 0 0)
  warning:        '#A0600B', // oklch(0.55 0.12 65)
  warningSoft:    '#FEF0D4', // oklch(0.96 0.04 85)
  success:        '#2F7258', // oklch(0.5 0.08 165)
  successSoft:    '#E0F4EA', // oklch(0.95 0.025 165)
  corporate:      '#2E5072', // oklch(0.42 0.07 250)
  corporateSoft:  '#E5F0FC', // oklch(0.95 0.02 250)

  // Lines. The focus ring is gold.
  border:         '#E1E2DC', // oklch(0.91 0.008 110)
  input:          '#D8D8D1', // oklch(0.88 0.01 110)

  // The dark app rail (the main left-hand menu in the export)
  rail:           '#142B28', // oklch(0.27 0.03 185)
  railFg:         '#EDF0E8', // oklch(0.95 0.01 120)
  railMuted:      '#94A29A', // oklch(0.7 0.02 160)
}

// ── DARK MODE — NOT BUILT. Values only, carried so nobody has to go back to
// the export for them. Bee Hub has no dark mode; nothing reads this. It is a
// comment, not an export, so it cannot be imported by accident. From the
// export's `.dark` block, converted the same way. A name missing here keeps
// its light value in the export (accent, ring, railFg, railMuted, the
// *-foreground aliases).
//
//   ink:            '#CCCFC9', // oklch(0.85 0.008 130)
//   gold:           '#D6A866', // oklch(0.76 0.1 75)
//   goldSoft:       '#3F301B', // oklch(0.32 0.04 75)
//   sage:           '#81AFA9', // oklch(0.72 0.05 185)
//   sageSoft:       '#1A2D2A', // oklch(0.28 0.025 185)
//   band:           '#191B19', // oklch(0.22 0.005 150)
//   background:     '#0F1310', // oklch(0.18 0.008 160)
//   foreground:     '#E8E8E4', // oklch(0.93 0.006 110)
//   card:           '#171C19', // oklch(0.22 0.01 160)
//   popover:        '#171C19', // oklch(0.22 0.01 160)
//   primary:        '#9AC9C2', // oklch(0.8 0.05 185)
//   primaryFg:      '#0B1917', // oklch(0.2 0.02 185)
//   secondary:      '#232824', // oklch(0.27 0.01 150)
//   muted:          '#212521', // oklch(0.26 0.01 150)
//   mutedFg:        '#A2A69F', // oklch(0.72 0.01 130)
//   accentFg:       '#C9E5E0', // oklch(0.9 0.03 185)
//   destructive:    '#EA6B5E', // oklch(0.68 0.16 28)
//   destructiveSoft:'#47211C', // oklch(0.3 0.06 28)
//   warning:        '#E4AC59', // oklch(0.78 0.12 75)
//   warningSoft:    '#3C2A0E', // oklch(0.3 0.05 75)
//   success:        '#71BD9D', // oklch(0.74 0.09 165)
//   successSoft:    '#142F24', // oklch(0.28 0.04 165)
//   corporate:      '#87B2DF', // oklch(0.75 0.08 250)
//   corporateSoft:  '#192A3C', // oklch(0.28 0.04 250)
//   border:         '#2F3430', // oklch(0.32 0.01 150)
//   input:          '#3F4440', // oklch(0.38 0.01 150)
//   rail:           '#030E0C', // oklch(0.15 0.02 185)

// Corners — the export's base radius is 10px: sm 6 · md 8 · lg 10 · xl 14 · 2xl 18.
export const R = { sm: '6px', md: '8px', lg: '10px', xl: '14px', xxl: '18px', full: '9999px' }

// Buttons carry a subtle shadow, fields a very subtle one.
export const SHADOW = {
  btn: '0 1px 3px rgba(42,48,43,0.10), 0 1px 2px rgba(42,48,43,0.06)',
  field: '0 1px 2px rgba(42,48,43,0.05)',
  pop: '0 4px 6px -1px rgba(42,48,43,0.10), 0 2px 4px -2px rgba(42,48,43,0.10)',
  dialog: '0 10px 15px -3px rgba(42,48,43,0.12), 0 4px 6px -4px rgba(42,48,43,0.10)',
}

// Lato for headings and controls, Arvo for running text, Corinthia for the
// script flourish. A font stack names a face; it does not load it — see
// FONT_STYLESHEET_HREF.
export const FONT = {
  heading: "'Lato', system-ui, sans-serif",
  body: "'Arvo', Georgia, serif",
  script: "'Corinthia', cursive",
  ui: "'Lato', system-ui, sans-serif",
}

// The one web-font request for the new look. Character for character the
// address Settings → Emails has asked for since 2026-10-30, so a browser that
// has opened either screen already holds the fonts for the other. A rebuilt
// screen renders <link rel="stylesheet" href={FONT_STYLESHEET_HREF}> WITH
// ITSELF; it never goes in app/layout.tsx or globals.css, where it would
// reach screens that have not been rebuilt (Kevin: fonts change as each
// module updates).
export const FONT_STYLESHEET_HREF = 'https://fonts.googleapis.com/css2?family=Arvo:wght@400;700&family=Lato:wght@300;400;700&family=Corinthia&display=swap'

// A colour "at 50%" and the like: alpha(T.gold, 0.5).
export const alpha = (hex, a) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

// The export's faint gold honeycomb, for a card that wants it
// (background-image; the card supplies its own background colour).
export const HONEYCOMB = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='49' viewBox='0 0 28 49'%3E%3Cg fill='none' stroke='%23C89A56' stroke-opacity='0.22'%3E%3Cpath d='M13.99 9.25l13 7.5v15l-13 7.5L1 31.75v-15l12.99-7.5zM3 17.9v12.7l10.99 6.34 11-6.35V17.9l-11-6.34L3 17.9zM0 15l12.98-7.5V0h-2v6.35L0 12.69v2.3zm0 18.5L12.98 41v8h-2v-6.85L0 35.81v-2.3zM15 0v7.5L27.99 15H28v-2.31h-.01L17 6.35V0h-2zm0 49v-8l12.99-7.5H28v2.31h-.01L17 42.15V49h-2z'/%3E%3C/g%3E%3C/svg%3E")`
