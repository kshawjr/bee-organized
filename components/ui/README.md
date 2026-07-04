# components/ui — Bee Hub design-system primitives

App-wide presentational primitives (HIVE Phase 1, doc §8.5/§8.6), aligned to
the LOCKED mockup design language. This file is the seed of
`docs/bee-hub-design-language.md` (step-4 deliverable). Props-only: no data
fetching, no mock constants. Color semantics resolve through `CHIP_STYLES`
in `components/hive/shared/stageConfig.js` — the single display config.
Never redeclare stage constants; never import from `BeeHub.jsx`; never
import `lib/engagements.ts` from client code (pure constants live in
`components/hive/shared/stageRank.js` / `betaGate.js`).

## Locked visual values

**Surfaces & cards** — cards are pure `#fff`, border `0.5px solid
rgba(0,0,0,0.08)` (hairline), radius `10px`, padding `10px 12px`, no
shadows, no gradients. Page surface `#fdfdfc`; quiet fills (client
strip, metric cards) `#f7f6f4`; table/section cards radius `12px`;
buttons radius `8px`; modal radius `16px`; pills/tabs radius `20px`.

**Closed color vocabulary** — every color on a beta surface resolves to:
the `CHIP_STYLES` families (below, plus `quiet` `#F5F4EF`/`#b5b3ac`),
the neutrals `#fdfdfc` / `#f7f6f4` / `#fff` / `#1a1a18` / `#6b6b66` /
`#8a8a84` (`TEXT_MUTED`) / `#b5b3ac` (`TEXT_QUIET`) / `#c9c7c0`,
hairlines `rgba(0,0,0,0.08)` for cards/dividers and
`rgba(0,0,0,0.15)` (`HAIRLINE_BORDER`, `--hairline-border`) for buttons
and inputs, scrims `rgba(26,26,24,…)`, the brand-green 3-stop scale
`#0F6E56` (`GREEN_FILL`) / `#085041` (`GREEN_TEXT`) / `#1D9E75`
(`TEXT_SUCCESS`), the stage bar `#1D9E75` / `#378ADD` / `#ECEAE4`, and
accent blue `#378ADD` for links. Named values live in `ui/tokens.js`.
Anything else is a bug — grep before pushing.

**Icons** — `components/ui/icons.jsx`: inline Tabler Icons (MIT),
stroke-based, `currentColor`, default 16px (`size` prop; 14px in tab
pills, 13px in buttons, 11px in chips via `statusIconFor(styleKey)` —
the shared within-stage-status → icon map used by board chips and list
status text). No emoji glyphs on beta surfaces; no icon npm dependency.

**Typography** — 100% sans (app stack); no serif inside Phase 1 surfaces.
Primary text 13px / weight 500 / near-black `#1a1a18` (never 700).
Secondary 11px / muted `#8a8a84`. Values 12–13px / weight 500. Section
labels 12px / weight 500 / `#6b6b66`, sentence case, count after a `·` in
`#b5b3ac` ("Request · 10").

**Chips** — 11px / weight 500, padding `2px 8px`, radius `10px`, no
border. Dark-on-light pairs (exact, do not tweak per-surface):

| family | meaning | bg | text |
|---|---|---|---|
| teal | new / go / requested | `#E1F5EE` | `#085041` |
| blue | in-motion (sent / scheduled / in progress / upcoming) | `#E6F1FB` | `#0C447C` |
| green | approved | `#EAF3DE` | `#27500A` |
| amber | attention / nurture / never invoiced | `#FAEEDA` | `#633806` |
| red | money owed | `#FCEBEB` | `#791F1F` |
| purple | repeat / relationship | `#EEEDFE` | `#3C3489` |
| gray | past / closed / neutral | `#F1EFE8` | `#444441` |

**Spacing** — 12px between cards, 16px between board columns; generous,
the layout breathes.

**Copy idiom (updated 2026-07-04)** — status texts, chip labels, and
detail-line phrases are Title Case with small words lowered ('Requested
Today', 'Never Invoiced', 'Owes $620', 'Working the Lead', 'Inquired Apr
2024 · Never Booked · Drips Paused'); ages are spelled out and
singular-correct via the shared `formatAge`/`formatDayCount`
(`2 Hours`, `1 Day`, `42 Days` — never `2h`/`d42`); 'ago' stays
lowercase. Buttons and letterspaced micro-labels keep their existing
rules (sentence-case buttons, uppercase-by-transform section labels).

## Primitives

### StatusChip
`{ label, styleKey?, icon? }` — colored pill per the locked chip anatomy.
`styleKey` is any `CHIP_STYLES` key (families above, plus every engagement
stage, client status, and within-stage state: `sent`, `approved`,
`changes_requested`, `nurturing`, `upcoming`, `scheduled`, `in_progress`,
`owing`, `paid`, `never_invoiced`, `repeat`). Unknown keys → gray.

### Card
`{ children, onClick?, highlighted? }` — locked card surface (see above).
`onClick` makes it interactive; `highlighted` swaps the hairline to teal
(`rgba(8,80,65,0.35)`) — still no shadow.

### Row
`{ left?, primary, secondary?, right?, onClick? }` — two-line list row on
the card surface. `left`/`right` are free slots; `primary`/`secondary`
ellipsize. Compresses naturally on mobile.

### FilterChips
`{ items, active, onChange }` — quiet horizontal chip strip;
`items: [{ key, label, count?, muted? }]`. Active chip is a white
hairline-bordered pill with a weight-500 label ('Open · 7' — count after
a middot in muted gray); inactive chips are borderless muted text;
`muted: true` renders extra-quiet. Scrolls horizontally on narrow
viewports instead of wrapping.

### MetricCard
`{ label, value, tone? }` — stat card: muted uppercase label, 22px value.
`tone` tints the value via `CHIP_STYLES` text colors.

### Banner
`{ icon, text, action?, tone? }` — tinted notice strip, radius 8, no
border; icon + single-line 12px text in the tone's dark text color;
`action: { label, onClick }` renders a compact white hairline button
(13px) right-aligned. Default tone `amber`.

### SectionHeader
`{ label, count? }` — the locked section label ("Request · 10" style).
