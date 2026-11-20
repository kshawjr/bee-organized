// lib/network/click-away-footprint.ts
// ─────────────────────────────────────────────────────────────
// The Network slices' footprint tests pin BeeHub.jsx and the old
// hive/NetworkScreen.jsx by fingerprint: "the Network work changed nothing
// outside Network". The click-away pass (Kevin, 2026-11-19, a Bee Hub-wide
// change, not a Network slice) touched both files on purpose, with exactly
// the lines below. Those tests take these lines back out before comparing,
// so ANY other change to either file still fails them.
//
// Each piece must be present exactly once (or the stated number of times),
// so this cannot quietly stop matching and hide a real change.
// ─────────────────────────────────────────────────────────────

const HUB_PIECES: [string, string, number][] = [
  ['import { useClickAway } from "@/components/ui/useClickAway"\n', '', 1],
  ['          data-loc-picker-trigger\n', '', 2],
  ['<button data-loc-picker-trigger onClick={()=>setShowLocPicker(!showLocPicker)}', '<button onClick={()=>setShowLocPicker(!showLocPicker)}', 1],
  ['          data-mobile-profile-trigger\n', '', 1],
  [`  // The phone profile menu and the location picker close on a click away
  // (Kevin, 2026-11-19): neither holds anything a person typed that matters
  // (the picker's search box only narrows the list) and each tap applies at
  // once, so a click away only closes them. Their buttons count as inside, so
  // pressing a button again still toggles it shut. components/ui/useClickAway.js
  useClickAway(showMobileProfile, () => setShowMobileProfile(false),
    (t) => !!t.closest?.('[data-mobile-profile-menu],[data-mobile-profile-trigger]'))
  useClickAway(showLocPicker, () => setShowLocPicker(false),
    (t) => !!t.closest?.('[data-loc-picker],[data-loc-picker-trigger]'))
`, '', 1],
  ['<div data-mobile-profile-menu style={{', '<div style={{', 1],
  ['<div data-loc-picker style={{', '<div style={{', 1],
]

const NETWORK_SCREEN_PIECES: [string, string, number][] = [
  [' onClose={() => setFiltersOpen(false)}>', '>', 1],
]

function strip(src: string, pieces: [string, string, number][], file: string): string {
  let s = src
  for (const [piece, back, times] of pieces) {
    const n = s.split(piece).length - 1
    if (n !== times) throw new Error(`${file}: the click-away piece ${JSON.stringify(piece.slice(0, 60))} appears ${n} times, expected ${times}`)
    s = s.split(piece).join(back)
  }
  return s
}

/** The file as it was before the click-away pass, if that pass is all that changed in it. */
export function withoutClickAway(file: string, src: string): string {
  if (file === 'components/BeeHub.jsx') return strip(src, HUB_PIECES, file)
  if (file === 'components/hive/NetworkScreen.jsx') return strip(src, NETWORK_SCREEN_PIECES, file)
  return src
}
