// lib/network/mailchimp-review-hub-footprint.ts
// ─────────────────────────────────────────────────────────────
// Mailchimp slice 5 (FL-75, 2026-11-24) changed components/BeeHub.jsx on
// purpose, in the Mailchimp card only: a "Review who goes to Mailchimp"
// button in the ready state, which opens components/settings/
// MailchimpReviewScreen.jsx. Several older tests pin BeeHub.jsx by
// fingerprint ("this slice changed nothing else"). They take THIS change back
// out first, by these exact pieces — each must be present exactly once, and
// the file with all of them taken out is byte for byte origin/main d41e711.
// So ANY other change to BeeHub.jsx still fails those tests.
//
// [what is there now, what main had].
// ─────────────────────────────────────────────────────────────

export const MAILCHIMP_REVIEW_HUB_PIECES: [string, string][] = [
  ['import MailchimpReviewScreen from "@/components/settings/MailchimpReviewScreen"\n', ''],
  ["  // FL-75 slice 5: the \"Who goes to Mailchimp\" review screen, opened from the\n  // ready state. It sends nothing; Sync now below is unchanged.\n  const [reviewing, setReviewing] = useState(false)\n", ''],
  ["  if (reviewing && state === 'ready') return <MailchimpReviewScreen locationId={locationId} onClose={()=>setReviewing(false)} />\n\n", ''],
  ["            {/* FL-75 slice 5 — choose who goes to Mailchimp. Opens the review\n                screen; nothing is sent from it. */}\n            <button onClick={()=>setReviewing(true)} className=\"bee-small-action\" data-testid=\"mc-open-review\"\n              style={{ display:'block', marginTop:'12px', padding:'9px 16px', background:'transparent', border:HT.border.control, borderRadius:HT.radius.control, fontFamily:'inherit', fontWeight:700, color:HT.accent.fg, cursor:'pointer' }}>\n              Review who goes to Mailchimp\n            </button>\n\n", ''],
]

/** BeeHub.jsx with Mailchimp slice 5 taken back out. Throws if a piece is missing or doubled. */
export function withoutMailchimpReviewSlice5(src: string): string {
  let s = src
  for (const [piece, back] of MAILCHIMP_REVIEW_HUB_PIECES) {
    const n = s.split(piece).length - 1
    if (n !== 1) throw new Error(`BeeHub.jsx: a Mailchimp slice 5 piece ${JSON.stringify(piece.slice(0, 60))} appears ${n} times, expected 1`)
    s = s.split(piece).join(back)
  }
  return s
}
