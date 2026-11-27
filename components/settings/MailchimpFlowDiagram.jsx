'use client'
// components/settings/MailchimpFlowDiagram.jsx
//
// THE DIRECTION PICTURE (FL-75, 2026-11-27), from Kevin's approved Lovable
// design ("Bee Organized Control Hive", MailchimpFlowDiagram.tsx). Kevin: "it's
// still hard to digest" — the two review steps looked nearly the same, so an
// owner couldn't tell at a glance whether people were arriving or leaving.
//
// Bee Hub and Mailchimp as two boxes with their marks, two arrows between
// them, the count on the arrow. The same place on every step:
//   overview, step 1, last step, finish — both arrows lit, each with its number
//   step 2 — Mailchimp → Bee Hub lit, the other faint
//   step 3 — Bee Hub → Mailchimp lit, the other faint
// Direction reads without a word: which way the arrowhead points, and which
// arrow is lit. A faint arrow carries no number (as in the design).
//
// THE NUMBERS obey the honesty rule: only people who will actually move — the
// same numbers as the headlines, never held, refused, skipped or unticked.
// null = not known yet, so no number is shown rather than a guess.
//
// Small and calm. No looping animation. At phone width the boxes stack and the
// arrows run up and down, so no text shrinks.

import { T, R, FONT } from '@/components/design/tokens'

const MAILCHIMP_MARK = 'https://www.google.com/s2/favicons?domain=mailchimp.com&sz=128'

const CSS = `
[data-mcf]{box-sizing:border-box;margin:0 auto;width:100%;max-width:576px;border-radius:${R.xl};border:1px solid ${T.border};background:${T.card};padding:12px}
[data-mcf] *{box-sizing:border-box}
[data-mcf] p{margin:0}
[data-mcf-body]{display:grid;grid-template-columns:104px minmax(112px,1fr) 104px;align-items:center;gap:12px}
[data-mcf-arrows]{display:grid;gap:4px}
[data-mcf-arrow]{position:relative;height:40px;display:flex;align-items:center;justify-content:center}
[data-mcf-arrow][data-lit="0"]{opacity:.35}
[data-mcf-arrow] svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
[data-mcf-v]{display:none}
[data-mcf-box]{border-radius:${R.lg};border:1px solid ${T.border};background:${T.background};text-align:center;padding:12px 8px;display:grid;justify-items:center;gap:6px}
[data-mcf-count]{position:relative;z-index:1;display:grid;place-items:center;min-height:32px;min-width:44px;border-radius:9999px;background:${T.primary};color:${T.primaryFg};padding:4px 8px;font-family:${FONT.ui};font-size:16px;line-height:1;font-weight:700;font-variant-numeric:tabular-nums;box-shadow:0 1px 2px rgba(0,0,0,.08)}
@media (min-width:640px){[data-mcf]{padding:16px}}
@media (max-width:639.98px){
[data-mcf-body]{display:flex;flex-direction:column;align-items:center;gap:0}
[data-mcf-box]{display:flex;align-items:center;justify-content:center;gap:12px;width:176px;padding:10px 16px}
[data-mcf-arrows]{grid-template-columns:1fr 1fr;width:160px;gap:20px}
[data-mcf-arrow]{height:96px}
[data-mcf-h]{display:none}
[data-mcf-v]{display:block}
}
`

function Box({ side }) {
  return (
    <div data-mcf-box data-side={side}>
      {side === 'bee'
        ? <span aria-hidden="true" style={{ fontSize: '28px', lineHeight: 1 }}>🐝</span>
        : <img src={MAILCHIMP_MARK} alt="" style={{ width: '28px', height: '28px', objectFit: 'contain' }} />}
      <p style={{ fontFamily: FONT.ui, fontSize: '12px', lineHeight: '16px', fontWeight: 700, color: T.foreground }}>{side === 'bee' ? 'Bee Hub' : 'Mailchimp'}</p>
    </div>
  )
}

// One arrow, drawn twice (across for desktop, up/down for phone; CSS shows
// one), with one number. "in" points at Bee Hub: left across, up on a phone.
function Arrow({ dir, lit, count }) {
  const c = lit ? T.primary : T.border
  const left = dir === 'in'
  return (
    <div data-mcf-arrow data-testid={'mcg-flow-' + dir} data-dir={dir} data-lit={lit ? '1' : '0'}>
      <svg data-mcf-h viewBox="0 0 200 40" preserveAspectRatio="none" aria-hidden="true">
        <line x1={left ? 14 : 0} y1="20" x2={left ? 200 : 186} y2="20" stroke={c} strokeWidth="4" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <svg data-mcf-h viewBox="0 0 40 40" aria-hidden="true" style={{ width: '32px', height: '32px', inset: 'auto', top: '4px', [left ? 'left' : 'right']: '-4px' }}>
        <path d={left ? 'M26 8 14 20l12 12' : 'M14 8l12 12-12 12'} fill="none" stroke={c} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <svg data-mcf-v viewBox="0 0 40 200" preserveAspectRatio="none" aria-hidden="true">
        <line x1="20" y1={left ? 14 : 0} x2="20" y2={left ? 200 : 186} stroke={c} strokeWidth="4" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <svg data-mcf-v viewBox="0 0 40 40" aria-hidden="true" style={{ width: '32px', height: '32px', inset: 'auto', left: 'calc(50% - 16px)', [left ? 'top' : 'bottom']: '-4px' }}>
        <path d={left ? 'M8 26 20 14l12 12' : 'M8 14l12 12 12-12'} fill="none" stroke={c} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {lit && count != null && <span data-mcf-count data-testid={'mcg-flow-' + dir + '-count'}>{Number(count).toLocaleString('en-US')}</span>}
    </div>
  )
}

const people = (x) => `${Number(x).toLocaleString('en-US')} ${Number(x) === 1 ? 'person' : 'people'}`
export function flowWords(flow) {
  const inW = flow.incoming == null ? 'People' : people(flow.incoming)
  const outW = flow.outgoing == null ? 'people' : people(flow.outgoing)
  if (flow.active === 'in') return `${inW} coming from Mailchimp into Bee Hub. Nobody goes to Mailchimp in this step.`
  if (flow.active === 'out') return `${flow.outgoing == null ? 'People' : people(flow.outgoing)} going from Bee Hub to Mailchimp. Nobody comes into Bee Hub in this step.`
  return `${inW} from Mailchimp into Bee Hub, and ${outW} from Bee Hub to Mailchimp.`
}

export default function MailchimpFlowDiagram({ flow }) {
  const lit = (d) => flow.active === 'both' || flow.active === d
  return (
    <figure data-mcf data-testid="mcg-flow" data-flow={flow.active} role="img" aria-label={flowWords(flow)} style={{ margin: '0 auto' }}>
      <style>{CSS}</style>
      <div data-mcf-body>
        <Box side="bee" />
        <div data-mcf-arrows>
          <Arrow dir="in" lit={lit('in')} count={flow.incoming} />
          <Arrow dir="out" lit={lit('out')} count={flow.outgoing} />
        </div>
        <Box side="mailchimp" />
      </div>
    </figure>
  )
}
