// components/hive/shared/tokens.js
// ─────────────────────────────────────────────────────────────
// THE single source for hive card visual values (design-system pass,
// Kevin's 7/10 sharp/clean/modern direction). Every color, radius,
// shadow, and hairline in components/hive/** resolves through here —
// the beta-hive-tokens source sweep fails any new literal outside this
// file. PURE module (only the equally-pure ui/tokens import) — safe in
// any bundle.
//
// Names are SEMANTIC (surface/ink/hairline/accent), never color names:
// a future dark-mode flip is a value swap in this file, not a re-sweep.
//
// Palette notes:
//   · canvas is a hair warm (#F6F5F0) so white raised cards float on a
//     real border + two-layer soft shadow — the card-lift idiom.
//   · hairlines are the warm #F0EEE7 family (bee/cream brand), not
//     cold rgba(0,0,0,…) grays.
//   · ONE action accent: the brand teal (ui/tokens GREEN_FILL). Stage/
//     status chip families keep their per-stage semantic colors — those
//     encode meaning (family.* below); the ACTION accent never varies.
// ─────────────────────────────────────────────────────────────

import { GREEN_FILL, GREEN_TEXT, TEXT_SUCCESS } from '@/components/ui/tokens'

export const T = {
  // ── ink — text/icon foregrounds, darkest → lightest ──────────
  ink: {
    primary: '#1a1a18',   // headings, primary copy, money
    strong: '#444441',    // emphatic secondary (gray-family text)
    secondary: '#6b6b66', // anchor text in meta lines
    muted: '#8a8a84',     // detail text, labels, ages
    quiet: '#b5b3ac',     // placeholders, empty states, counts
    faint: '#c9c7c0',     // ghost hints (pencil-era ghost tier)
    disabled: '#dedcd5',  // disabled control glyphs
    inverse: '#fff',      // text/icons on dark or accent fills
  },

  // ── surfaces ──────────────────────────────────────────────────
  surface: {
    canvas: '#F6F5F0',            // the page — warm, cards float on it
    raised: '#fff',               // cards, menus, inputs, sheets
    sunken: '#f7f6f4',            // quiet insets (description, banners)
    hover: '#f7f6f4',             // menu-row / segment hover fill
    scrim: 'rgba(26,26,24,0.35)', // overlay backdrop
  },

  // ── hairlines — the warm line family (colors) ─────────────────
  hairline: {
    soft: '#F0EEE7',    // dividers inside cards (quietest)
    line: '#ECEAE3',    // card borders, menu/popover borders
    control: '#DBD8CF', // interactive chrome — inputs, quiet buttons
    strong: '#C9C5B8',  // emphasis borders (current row, focus-ish)
  },

  // ── borders — full shorthand strings (the usual call-site form) ──
  border: {
    card: '1px solid #ECEAE3',        // raised-card lift border
    thin: '0.5px solid #ECEAE3',      // menus, popovers, chips-with-border
    divider: '0.5px solid #F0EEE7',   // in-card rules and cell dividers
    control: '0.5px solid #DBD8CF',   // inputs, selects, quiet buttons
    strong: '0.5px solid #C9C5B8',    // emphasized (current) boxes
    dashedSoft: '0.5px dashed #ECEAE3',
    dashed: '0.5px dashed #C9C5B8',   // pending/placeholder boxes
    underline: '1px dashed #C9C5B8',  // inline-editable affordance
  },

  // ── shadows — two-layer soft lift; overlays keep their depth ──
  shadow: {
    card: '0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.05)',
    pop: '0 8px 24px rgba(0,0,0,0.14)',        // menus, popovers
    float: '0 8px 30px rgba(26,26,24,0.12)',   // FAB, floating chrome
    drawer: '0 12px 40px rgba(26,26,24,0.22)',
    overlay: '0 1px 2px rgba(0,0,0,0.04), 0 24px 80px rgba(26,26,24,0.22)', // centered modal — two-layer soft lift (contact + deep drop)
    sheet: '0 -8px 40px rgba(26,26,24,0.2)',    // mobile bottom sheet
    knob: '0 1px 3px rgba(0,0,0,0.25)',         // toggle knob
  },

  // ── radii — the consistent scale ─────────────────────────────
  radius: {
    card: '16px',    // raised cards, overlay panels
    inset: '11px',   // insets, buttons, action rows, popovers
    control: '8px',  // inputs, selects, small buttons
    chip: '8px',     // stage/status chips — rectangles, not pills
    pill: '20px',    // tags + counts stay pills (categorical)
    round: '50%',
  },

  // ── type — typeset numerals + titles ─────────────────────────
  type: {
    trackTitle: '-0.015em', // headings/names
    trackNum: '-0.01em',    // money + figures
    tabular: 'tabular-nums',
  },

  // ── badge + avatar scale — ONE anatomy both cards share ───────
  // Status/stage CHIPS stay rectangles (StatusChip → radius.chip); the
  // person/category PILLS (assignees, tags, + add affordances) and the
  // inline avatars read their size/type from HERE, so a masthead or
  // left-column row of mixed chips + pills + buttons sits on one
  // baseline instead of each component picking its own height. Both
  // cards reach through cardKit.pillStyle to this, never per-card px.
  badge: {
    font: '11px',      // chip + pill text (StatusChip references this too)
    weight: 500,
    height: '22px',    // shared pill / + add control height (chips read level)
    padX: '10px',      // pill / + add horizontal inset
    padAvatarL: '4px', // tighter left inset when a leading avatar rides
    gap: '6px',
  },
  avatar: {
    identity: '32px',     // masthead identity circle (InitialsAvatar) — one anatomy with inbox/directory rows
    identityFont: '11px',
    inline: '18px',       // inline assignee / secondary-contact minis
    inlineFont: '9px',
  },

  // ── THE action accent (brand teal — ui/tokens GREEN_FILL) ─────
  accent: {
    fg: GREEN_FILL,                   // solid fills, links, active states
    deep: GREEN_TEXT,                 // dark stop — text on soft tint
    soft: 'rgba(15,110,86,0.10)',     // tinted button fills
    faint: 'rgba(15,110,86,0.05)',    // hover/selected wash
    onFill: '#fff',
  },

  // ── semantic states (non-chip surfaces) ───────────────────────
  state: {
    success: { fg: TEXT_SUCCESS, soft: 'rgba(29,158,117,0.10)', ring: 'rgba(29,158,117,0.4)', ringSoft: 'rgba(29,158,117,0.3)', wash: 'rgba(29,158,117,0.08)' },
    danger: { fg: '#791F1F', soft: '#FCEBEB', strong: '#b42318', wash: 'rgba(121,31,31,0.06)' },
    warning: { fg: '#B7791F', deep: '#633806', soft: 'rgba(183,121,31,0.12)', bg: '#FAEEDA' },
    info: { fg: '#378ADD', deep: '#0C447C', mid: '#2b6aad', soft: 'rgba(55,138,221,0.10)', bg: '#E6F1FB' },
    neutralSoft: 'rgba(0,0,0,0.06)',  // gray action-tone tint
  },

  // ── the CORPORATE category marker (records no location owns yet) ──
  // A warm SAND family, and deliberately its own group rather than a reuse
  // of state.warning: this marks a CATEGORY ("corporate holds this, no
  // location does"), not an urgency. It must not read as the teal action
  // accent (that would make a container look clickable) and it must not
  // read as Home's needs-attention urgency tones, which are a saturated
  // red/orange pair — so these are desaturated, earthy, and darker.
  // Today's only consumer is the Inbox's unrouted routing queue.
  corp: {
    bg: '#F6EFE1',      // the container tint — sand wash on the warm canvas
    border: '#E5D8C0',  // its own edge, a step deeper than the tint
    fg: '#7A5C25',      // header label + glyph ink (5.4:1 on bg)
    deep: '#5A431A',    // body copy on the tint
    fill: '#8E6620',    // the routing action's filled control (5.2:1 on white)
    onFill: '#fff',
  },

  // ── chip color families (§8.6 design language — LOCKED pairs) ──
  // Per-stage/status semantics stay; stageConfig composes CHIP_STYLES
  // from THESE. Dark text on light fills, always.
  family: {
    teal: { bg: '#E1F5EE', text: GREEN_TEXT },
    blue: { bg: '#E6F1FB', text: '#0C447C' },
    green: { bg: '#EAF3DE', text: '#27500A' },
    amber: { bg: '#FAEEDA', text: '#633806' },
    red: { bg: '#FCEBEB', text: '#791F1F' },
    purple: { bg: '#EEEDFE', text: '#3C3489' },
    gray: { bg: '#F1EFE8', text: '#444441' },
    quiet: { bg: '#F5F4EF', text: '#b5b3ac' },
  },

  // ── the dark identity-scope control (top bar) — its own dark
  // sub-surface, deliberately outside the light card system ──────
  scope: {
    ringAmber: '#d4a046',
    avatarAmber: 'linear-gradient(135deg,#d4a046,#b07a20)',
    onDarkSoft: 'rgba(255,255,255,0.04)',
    onDarkBorder: '1px solid rgba(255,255,255,0.12)',
  },
}

// Sage helper for the scope control's dynamic-alpha accents (pure).
export const sage = (a) => `rgba(168,201,196,${a})`
