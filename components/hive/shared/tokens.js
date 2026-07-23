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
// Palette notes (brand pass, 7/23 — beeorganized.com alignment):
//   · canvas is a hair warm (#F6F5F0) so white raised cards float on a
//     real border + two-layer soft shadow — the card-lift idiom. This
//     warmth is OURS, deliberately: the public site has no cream in its
//     CSS at all (every mounted surface there is #ffffff — the warmth a
//     visitor perceives comes from photography and the hexagon-fade
//     raster). Keeping the warm canvas is therefore a choice, not a
//     brand miss, and it keeps the "bee/cream" hairline family coherent.
//   · hairlines are the warm #F0EEE7 family (bee/cream brand), not
//     cold rgba(0,0,0,…) grays. The two INTERACTIVE stops (hairline
//     .control / .strong) are darker than the decorative ones on
//     purpose: a control boundary must clear WCAG 1.4.11 (3:1), which
//     the old #DBD8CF / #C9C5B8 pair did not.
//   · ONE action accent: the brand teal (ui/tokens GREEN_FILL), now the
//     site's own deep teal — the value beeorganized.com ships as
//     color-scheme-inverse's secondary background / button-hover fill.
//     Brand-derived, not invented. Stage/status chip families keep
//     their per-stage semantic colors — those encode meaning (family.*
//     below); the ACTION accent never varies.
//   · brand.* holds the two SIGNATURE colors — sage and gold. Both are
//     DECORATIVE FILLS ONLY. Neither can carry white text:
//         white on sage #A8C9C4 = 1.78:1   white on gold #D4A049 = 2.35:1
//     Both are ~3x short of AA, so white-on-sage and white-on-gold are
//     BANNED app-wide (pinned in beta-palette-contrast.test.ts). When
//     text must sit on them, use brand.onSage / brand.onGold; when a
//     gold thing must carry text or bear white, use brand.goldText /
//     brand.goldFill, which are the same hue driven dark enough to pass.
//   · every text/background pair below clears AA at NORMAL size (4.5:1)
//     against BOTH #fff and the warm canvas — no reliance on the
//     large-text exemption anywhere. Kevin's audience is 45-65 and the
//     open complaint is that type reads small; a thin ink stop makes
//     that worse. The one documented exemption is ink.disabled, which
//     WCAG 1.4.3 excludes as an inactive UI component.
// ─────────────────────────────────────────────────────────────

import { GREEN_FILL, GREEN_TEXT, TEXT_SUCCESS, WARNING_BG, WARNING_TEXT } from '@/components/ui/tokens'

export const T = {
  // ── ink — text/icon foregrounds, darkest → lightest ──────────
  // EVERY stop here except `disabled` clears 4.5:1 on BOTH #fff and the
  // warm canvas. The old ladder failed from `muted` down (muted 3.18:1,
  // quiet 1.92:1, faint 1.55:1 on canvas) — three of five tiers were
  // decorative-only in practice while carrying real copy: `quiet` runs
  // placeholders and counts, `faint` runs the "add address"/"add source"
  // empty-state affordances. Raising the floor to AA compresses the
  // bottom three tiers into a narrow band (5.70 / 4.98 / 4.56 on canvas)
  // — they read closer together than before, and that is the deliberate
  // cost of legibility. The darker top stops re-open the ladder so the
  // hierarchy still reads. `disabled` stays light: WCAG 1.4.3 exempts
  // inactive components, and a disabled control that looks enabled is a
  // worse bug than a faint one.
  ink: {
    primary: '#1a1a18',   // headings, primary copy, money
    strong: '#3C3C37',    // emphatic secondary (gray-family text)
    secondary: '#54544F', // anchor text in meta lines
    muted: '#61615C',     // detail text, labels, ages
    quiet: '#6A6A65',     // placeholders, empty states, counts
    faint: '#70706B',     // ghost hints (pencil-era ghost tier)
    disabled: '#dedcd5',  // disabled control glyphs — WCAG 1.4.3 exempt
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
  // TWO tiers with different jobs. soft/line are DECORATIVE rules inside
  // and around cards — nothing depends on seeing them to operate a
  // control, so they stay whisper-quiet. control/strong ARE the visible
  // boundary of an input, a quiet button, or an inline-editable value,
  // which puts them under WCAG 1.4.11 (3:1 against the adjacent
  // surface). The old #DBD8CF / #C9C5B8 sat at 1.31 / 1.58 on canvas —
  // effectively invisible. These clear 3:1 on both #fff and the canvas
  // and stay in the warm family rather than going cold gray.
  hairline: {
    soft: '#F0EEE7',    // dividers inside cards (quietest)
    line: '#ECEAE3',    // card borders, menu/popover borders
    control: '#918D80', // interactive chrome — inputs, quiet buttons (1.4.11)
    strong: '#7F7B6E',  // emphasis borders (current row, focus-ish)
  },

  // ── borders — full shorthand strings (the usual call-site form) ──
  border: {
    card: '1px solid #ECEAE3',        // raised-card lift border
    thin: '0.5px solid #ECEAE3',      // menus, popovers, chips-with-border
    divider: '0.5px solid #F0EEE7',   // in-card rules and cell dividers
    control: '0.5px solid #918D80',   // inputs, selects, quiet buttons
    strong: '0.5px solid #7F7B6E',    // emphasized (current) boxes
    dashedSoft: '0.5px dashed #ECEAE3',
    dashed: '0.5px dashed #7F7B6E',   // pending/placeholder boxes
    underline: '1px dashed #7F7B6E',  // inline-editable affordance
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
  // The stops are now the SITE's teal, not a near-miss of it: the public
  // theme ships this exact value as color-scheme-inverse's secondary
  // background and as its button-hover fill. soft/faint are solid hexes
  // rather than rgba() so a contrast assertion can actually evaluate
  // them — an alpha wash has no fixed ratio until you know what it sits
  // on, which is exactly the ambiguity that let unreadable pairs through.
  // Every call site puts them over a raised/canvas surface anyway.
  accent: {
    fg: GREEN_FILL,      // solid fills, links, active states
    hover: '#033734',    // the darker stop a filled control moves to
    deep: GREEN_TEXT,    // dark stop — text on soft tint
    soft: '#E3EEEC',     // tinted button fills
    faint: '#F1F7F5',    // hover/selected wash
    onFill: '#fff',
  },

  // ── the two SIGNATURE brand colors — DECORATIVE FILLS ONLY ────
  // sage and gold are what makes a surface read as Bee Organized. They
  // are also both far too light to carry white text (1.78:1 and 2.35:1),
  // which is precisely the mistake the public site makes on its primary
  // button and its section headings. So they live here as FILLS, with
  // explicit partners for the moment text has to touch them:
  //   onSage / onGold — the ink to use ON a sage or gold fill
  //   goldText        — gold-hued INK for light surfaces (#fff, canvas)
  //   goldFill        — the gold stop dark enough to bear white text
  //   goldSoft        — the light gold band tint (shared with amber)
  // gold is #D4A049: the value Kevin picked off the RENDERED site, which
  // beats the #c89a56 declared in the stylesheet (the painted gold is
  // composited / lives in raster assets). It also reconciles the app's
  // pre-existing #d4a046 — almost certainly the same eyedropper, one
  // digit off — so there is now ONE gold, not two.
  brand: {
    sage: '#A8C9C4',      // decorative fill — avatars, charts, washes
    onSage: GREEN_TEXT,   // ink for text sitting on a sage fill
    gold: '#D4A049',      // decorative marker — icons, hex motifs
    onGold: '#1a1a18',    // ink for text sitting on a gold fill
    goldText: '#7C581D',  // gold-hued ink on #fff / canvas
    goldFill: '#8C6421',  // gold fill that carries white text
    goldSoft: '#F7EEDD',  // light gold band tint
  },

  // ── semantic states (non-chip surfaces) ───────────────────────
  // The three BRIGHT fg stops all carried real copy while failing AA —
  // success ran "Existing client · …" and the inline-edit ✓ at 3.39:1,
  // warning ran "Address required" at 3.64:1, info ran the Timeline
  // chips at 3.59:1. Each is the same hue driven dark enough to pass on
  // #fff, on the canvas, AND on its own soft wash. The ring/wash alphas
  // move with their fg so a tint never drifts off its ink.
  state: {
    success: { fg: TEXT_SUCCESS, soft: 'rgba(22,121,89,0.10)', ring: 'rgba(22,121,89,0.4)', ringSoft: 'rgba(22,121,89,0.3)', wash: 'rgba(22,121,89,0.08)' },
    danger: { fg: '#791F1F', soft: '#FCEBEB', strong: '#b42318', wash: 'rgba(121,31,31,0.06)' },
    warning: { fg: '#8C5C18', deep: WARNING_TEXT, soft: 'rgba(140,92,24,0.12)', bg: WARNING_BG },
    info: { fg: '#1F6BB7', deep: '#0C447C', mid: '#2b6aad', soft: 'rgba(31,107,183,0.10)', bg: '#E6F1FB' },
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
  // Four of the eight retune toward the brand or toward legibility:
  // teal picks up the site's sage/teal pair, amber is now derived from
  // brand gold rather than a generic orange, gray follows ink.strong,
  // and quiet — which sat at 1.91:1, the single worst pair in the app —
  // becomes readable. blue/green/red/purple already cleared 8:1 and are
  // untouched: there is no brand blue, green, red or purple to align to.
  family: {
    teal: { bg: '#E3EEEC', text: GREEN_TEXT },
    blue: { bg: '#E6F1FB', text: '#0C447C' },
    green: { bg: '#EAF3DE', text: '#27500A' },
    amber: { bg: WARNING_BG, text: WARNING_TEXT },
    red: { bg: '#FCEBEB', text: '#791F1F' },
    purple: { bg: '#EEEDFE', text: '#3C3489' },
    gray: { bg: '#F1EFE8', text: '#3C3C37' },
    quiet: { bg: '#F2F0EA', text: '#6A6A65' },
  },

  // ── the dark identity-scope control (top bar) — its own dark
  // sub-surface, deliberately outside the light card system ──────
  // The amber here is the SAME gold as brand.gold now (it was #d4a046 —
  // the same eyedropper, one digit adrift). onAmber exists because the
  // identity avatar is a gold disc: white initials on it were 2.35:1,
  // the banned white-on-gold pair. Darkening the disc instead would have
  // buried it in the dark sidebar, so the disc stays bright and the
  // initials go dark — more legible AND more on-brand.
  scope: {
    ringAmber: '#D4A049',
    avatarAmber: 'linear-gradient(135deg,#D4A049,#B07A20)',
    onAmber: '#1a1a18',
    onDarkSoft: 'rgba(255,255,255,0.04)',
    onDarkBorder: '1px solid rgba(255,255,255,0.12)',
  },
}

// Sage helper for the scope control's dynamic-alpha accents (pure).
// Same sage as brand.sage — the site's #A8C9C4, exactly.
export const sage = (a) => `rgba(168,201,196,${a})`
