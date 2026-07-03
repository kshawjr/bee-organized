# components/ui — Bee Hub design-system primitives

App-wide presentational primitives (HIVE Phase 1, doc §8.5/§8.6). Props-only:
no data fetching, no mock constants — consumers pass everything in. Color
semantics resolve through `CHIP_STYLES` in
`components/hive/shared/stageConfig.js`, the single stage/status display
config. Never redeclare stage constants; never import from `BeeHub.jsx`.

Tone/styleKey vocabulary (§8.6): `teal`=new/go · `blue`=in-motion ·
`amber`=attention/nurture · `red`=money-owed · `purple`=relationship/repeat ·
`gray`=past/closed. `CHIP_STYLES` also maps every engagement stage, client
status, and within-stage state (`sent`, `approved`, `changes_requested`,
`nurturing`, `upcoming`, `scheduled`, `in_progress`, `owing`, `paid`,
`never_invoiced`, `repeat`) so callers can pass those keys directly.

## StatusChip
`{ label, styleKey?, icon?, size? }` — colored pill, dark text on light fill.
`styleKey` is any `CHIP_STYLES` key (unknown → gray). `size`: `'md'`
(default) or `'sm'`. `icon` renders before the label.

## Card
`{ children, onClick?, highlighted? }` — white card, hairline border, radius
10. `onClick` makes it interactive (pointer cursor); `highlighted` swaps to a
teal border + soft shadow.

## Row
`{ left?, primary, secondary?, right?, onClick? }` — two-line list row.
`left`/`right` are free slots (avatar, chips, value); `primary`/`secondary`
ellipsize. Compresses naturally on mobile (slots flex, text truncates).

## FilterChips
`{ items, active, onChange }` — horizontal chip strip;
`items: [{ key, label, count?, styleKey? }]`. Active chip inverts to ink;
inactive chips tint by `styleKey` when given. Scrolls horizontally on narrow
viewports instead of wrapping (§7 mobile rule).

## MetricCard
`{ label, value, tone? }` — stat card: muted uppercase label, 22px value.
`tone` tints the value via `CHIP_STYLES` text colors.

## Banner
`{ icon, text, action?, tone? }` — icon + text strip with optional action
button; `action: { label, onClick }`. `tone` (default `amber`) tints the
fill; the action button uses the tone's text color as its background.

## SectionHeader
`{ label, count? }` — muted uppercase section label (`#8a9e9a`,
letter-spaced) with optional count, per the app's section-label convention.
