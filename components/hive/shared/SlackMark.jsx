// components/hive/shared/SlackMark.jsx
// ─────────────────────────────────────────────────────────────
// Slack's mark, as Slack publishes it. NOT drawn here: the eight paths and
// the four colours below are copied character for character from Slack's own
// file, Slack_Mark.svg, downloaded 2026-11-12 from Slack's brand asset host
// (cdn.brandfolder.io/5H442O3W/…/Slack_Mark.svg).
// lib/beta-slack-mark-button.test.tsx pins them, so an edit here that
// redraws or recolours the mark fails a test.
//
// Slack's brand terms (slack.com/terms-of-service/slack-brand), the ones
// that bear on a small mark in a button:
//   · don't use different colours or shuffle them   → the four fills, as is
//   · don't crop, rotate, distort, outline          → the paths, as is, square
//   · no shadows, effects, animation, transparency  → none; it is never dimmed
//   · clear space of at least one pill's length     → the CALLER's job. The
//     published file carries its own margin (the mark is the middle 122.8 of
//     a 270 box); this viewBox is the mark's exact bounds, so the margin is
//     given back as padding by whatever holds it. A pill is 58.1 of 122.8,
//     so the padding must be at least 0.473 × `size` on every side.
//
// Decorative on its own (aria-hidden): the thing that holds it carries the
// name. §8.5 props only, no context.
// ─────────────────────────────────────────────────────────────
import React from 'react'
import { T } from './tokens'

// Slack's four colours live in tokens.js (the one file allowed a colour
// code), marked not-ours.
const C = T.slackMark

export const SLACK_MARK_PILL_RATIO = 58.1 / 122.8

export const SLACK_MARK_PATHS = [
  [C.red, 'M99.4,151.2c0,7.1-5.8,12.9-12.9,12.9c-7.1,0-12.9-5.8-12.9-12.9c0-7.1,5.8-12.9,12.9-12.9h12.9V151.2z'],
  [C.red, 'M105.9,151.2c0-7.1,5.8-12.9,12.9-12.9s12.9,5.8,12.9,12.9v32.3c0,7.1-5.8,12.9-12.9,12.9s-12.9-5.8-12.9-12.9V151.2z'],
  [C.blue, 'M118.8,99.4c-7.1,0-12.9-5.8-12.9-12.9c0-7.1,5.8-12.9,12.9-12.9s12.9,5.8,12.9,12.9v12.9H118.8z'],
  [C.blue, 'M118.8,105.9c7.1,0,12.9,5.8,12.9,12.9s-5.8,12.9-12.9,12.9H86.5c-7.1,0-12.9-5.8-12.9-12.9s5.8-12.9,12.9-12.9H118.8z'],
  [C.green, 'M170.6,118.8c0-7.1,5.8-12.9,12.9-12.9c7.1,0,12.9,5.8,12.9,12.9s-5.8,12.9-12.9,12.9h-12.9V118.8z'],
  [C.green, 'M164.1,118.8c0,7.1-5.8,12.9-12.9,12.9c-7.1,0-12.9-5.8-12.9-12.9V86.5c0-7.1,5.8-12.9,12.9-12.9c7.1,0,12.9,5.8,12.9,12.9V118.8z'],
  [C.yellow, 'M151.2,170.6c7.1,0,12.9,5.8,12.9,12.9c0,7.1-5.8,12.9-12.9,12.9c-7.1,0-12.9-5.8-12.9-12.9v-12.9H151.2z'],
  [C.yellow, 'M151.2,164.1c-7.1,0-12.9-5.8-12.9-12.9c0-7.1,5.8-12.9,12.9-12.9h32.3c7.1,0,12.9,5.8,12.9,12.9c0,7.1-5.8,12.9-12.9,12.9H151.2z'],
]

export default function SlackMark({ size = 14 }) {
  return (
    <svg data-slack-mark aria-hidden="true" focusable="false" width={size} height={size} viewBox="73.6 73.6 122.8 122.8"
      xmlns="http://www.w3.org/2000/svg" style={{ display: 'block', flexShrink: 0 }}>
      {SLACK_MARK_PATHS.map(([fill, d], i) => <path key={i} fill={fill} d={d} />)}
    </svg>
  )
}
