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
the `CHIP_STYLES` families (below, plus `quiet` `#F2F0EA`/`#6A6A65`),
the neutrals `#fdfdfc` / `#f7f6f4` / `#fff` / `#1a1a18` / `#54544F` /
`#61615C` (`TEXT_MUTED`) / `#6A6A65` (`TEXT_QUIET`) / `#70706B`,
hairlines `rgba(0,0,0,0.08)` for cards/dividers and
`rgba(0,0,0,0.45)` (`HAIRLINE_BORDER`, `--hairline-border`) for buttons
and inputs, scrims `rgba(26,26,24,…)`, the brand-teal 3-stop scale
`#054E4A` (`GREEN_FILL`) / `#03403C` (`GREEN_TEXT`) / `#167959`
(`TEXT_SUCCESS`), and the two brand markers `#A8C9C4` (sage) / `#D4A049`
(gold) as DECORATIVE FILLS ONLY. Named values live in `ui/tokens.js` and
`hive/shared/tokens.js`. Anything else is a bug — grep before pushing.

**Contrast is a constraint, not a guideline (brand pass 7/23)** — every
text/background pair the tokens can produce clears WCAG AA at NORMAL
size (4.5:1) against both `#fff` and the warm canvas `#F6F5F0`. Nothing
relies on the large-text exemption. Two pairs are BANNED outright, both
of which the public marketing site ships: white on sage (1.78:1) and
white on gold (2.35:1). Use `T.brand.onSage` / `T.brand.onGold` for ink
on those fills, or `T.brand.goldText` / `T.brand.goldFill` when a gold
thing must carry or bear text. `lib/beta-palette-contrast.test.ts`
enforces all of it — when it fails, change the VALUE, not the threshold.
The one documented exemption is `ink.disabled` (WCAG 1.4.3, inactive
components).

**Icons** — `components/ui/icons.jsx`: inline Tabler Icons (MIT),
stroke-based, `currentColor`, default 16px (`size` prop; 14px in tab
pills, 13px in buttons, 11px in chips via `statusIconFor(styleKey)` —
the shared within-stage-status → icon map used by board chips and list
status text). No emoji glyphs on beta surfaces; no icon npm dependency.

**Typography** — 100% sans (app stack); no serif inside Phase 1 surfaces.
Primary text 13px / weight 500 / near-black `#1a1a18` (never 700).
Secondary 11px / muted `#61615C`. Values 12–13px / weight 500. Section
labels 12px / weight 500 / `#54544F`, sentence case, count after a `·` in
`#6A6A65` ("Request · 10"). Sizes and weights are NOT set by the brand
pass — the marketing site runs 14px body at weight 300, which would make
the open "text is too small" complaint worse. That is its own decision.

**Chips** — 11px / weight 500, padding `2px 8px`, radius `10px`, no
border. Dark-on-light pairs (exact, do not tweak per-surface):

| family | meaning | bg | text |
|---|---|---|---|
| teal | new / go / requested | `#E3EEEC` | `#03403C` |
| blue | in-motion (sent / scheduled / in progress / upcoming) | `#E6F1FB` | `#0C447C` |
| green | approved | `#EAF3DE` | `#27500A` |
| amber | attention / nurture / never invoiced | `#F7EEDD` | `#6B4D19` |
| red | money owed | `#FCEBEB` | `#791F1F` |
| purple | repeat / relationship | `#EEEDFE` | `#3C3489` |
| gray | past / closed / neutral | `#F1EFE8` | `#3C3C37` |

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
stage, client status, and within-stage state: `draft`, `sent`, `approved`,
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
