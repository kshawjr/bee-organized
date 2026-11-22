// lib/network/footer-intent-footprint.ts
// ─────────────────────────────────────────────────────────────
// Partner emails, slice 3 fixes (2026-11-22): the email layout's footer
// argument became REQUIRED (lib/drip-email-layout.ts FooterIntent), so every
// file that builds an email through it now says what it always meant —
// NO_FOOTER('why') or { footer }. Several tests pin those files byte for byte
// ("nothing about what is sent changed"). They take exactly these edits back
// out first, in this order: each piece must be present exactly once, and the
// file with all of them put back is byte for byte what it was at 66c41af. So
// any OTHER change to these files still fails those tests, and what a client
// receives is pinned by output separately (lib/network/client-email-bytes.test.ts).
//
// Generated from the diff, never edited by hand: [what is there now, what
// 66c41af had].
// ─────────────────────────────────────────────────────────────

export const FOOTER_INTENT_PIECES: Record<string, [string, string][]> = {
  "lib/drip-send.ts": [
    ["  const html = buildBrandedDripHtml(rendered.body, { ...ctx, signature, ...look, bodyFormat }, NO_FOOTER('a drip step carries no CAN-SPAM footer'))\n  const text = buildBrandedDripText(rendered.body, { ...ctx, signature, ...look, bodyFormat }, NO_FOOTER('a drip step carries no CAN-SPAM footer'))\n",
     "  const html = buildBrandedDripHtml(rendered.body, { ...ctx, signature, ...look, bodyFormat })\n  const text = buildBrandedDripText(rendered.body, { ...ctx, signature, ...look, bodyFormat })\n"],
    ["import { buildBrandedDripHtml, buildBrandedDripText, NO_FOOTER } from './drip-email-layout'\n",
     "import { buildBrandedDripHtml, buildBrandedDripText } from './drip-email-layout'\n"],
  ],
  "lib/welcome-email.ts": [
    ["    html: buildBrandedDripHtml(renderedBody, brandCtx, { footer: canSpamFooter }),\n    text: buildBrandedDripText(renderedBody, brandCtx, { footer: canSpamFooter }),\n",
     "    html: buildBrandedDripHtml(renderedBody, brandCtx, canSpamFooter),\n    text: buildBrandedDripText(renderedBody, brandCtx, canSpamFooter),\n"],
  ],
  "lib/stage-emails.ts": [
    ["  const footer = commercial && canSpamFooter ? { footer: canSpamFooter } : NO_FOOTER('an estimate follow-up is transactional')\n",
     "  const footer = commercial ? canSpamFooter : null\n"],
    ["  NO_FOOTER,\n",
     ""],
  ],
  "app/api/emails/test-send/route.ts": [
    ["    html = buildBrandedDripHtml(rendered.body, brandCtx, NO_FOOTER('a drip step carries no CAN-SPAM footer'))\n    text = buildBrandedDripText(rendered.body, brandCtx, NO_FOOTER('a drip step carries no CAN-SPAM footer'))\n",
     "    html = buildBrandedDripHtml(rendered.body, brandCtx)\n    text = buildBrandedDripText(rendered.body, brandCtx)\n"],
    ["import { buildBrandedDripHtml, buildBrandedDripText, NO_FOOTER, type BrandedEmailContext } from '@/lib/drip-email-layout'\n",
     "import { buildBrandedDripHtml, buildBrandedDripText, type BrandedEmailContext } from '@/lib/drip-email-layout'\n"],
  ],
  "lib/feedback-reply-email.ts": [
    ["  const html = buildBrandedShellHtml(cardContentHtml, footerInner, NO_FOOTER('a reply to an owner about their feedback'))\n",
     "  const html = buildBrandedShellHtml(cardContentHtml, footerInner)\n"],
    ["  NO_FOOTER,\n",
     ""],
  ],
  "lib/lead-notification-email.ts": [
    ["  const html = buildBrandedShellHtml(cardContentHtml, footerBandHtml, NO_FOOTER('an internal new-lead notification'))\n",
     "  const html = buildBrandedShellHtml(cardContentHtml, footerBandHtml)\n"],
    ["import { buildBrandedShellHtml, EMAIL_TEXT, NO_FOOTER } from './drip-email-layout'\n",
     "import { buildBrandedShellHtml, EMAIL_TEXT } from './drip-email-layout'\n"],
  ],
  "lib/drip-email-layout.ts": [
    ["  if (footer?.text) parts.push('', footer.text)\n",
     "  if (cardFooter?.text) parts.push('', cardFooter.text)\n"],
    ["  const footer = footerOf(cardFooter)\n",
     ""],
    ["  ctx: BrandedEmailContext,\n  cardFooter: FooterIntent,\n): string {\n  // An html body is read back as text first; from there on the text half is\n",
     "  ctx: BrandedEmailContext,\n  cardFooter?: CardFooter | null,\n): string {\n  // An html body is read back as text first; from there on the text half is\n"],
    ["              ${reviewsHtml}`, footerInner, cardFooter, { style: ctx.style, heading: ctx.heading })\n",
     "              ${reviewsHtml}`, footerInner, cardFooter?.html ?? '', { style: ctx.style, heading: ctx.heading })\n"],
    ["  footerOf(cardFooter) // checked before anything is built\n",
     ""],
    ["  cardFooter: FooterIntent,\n): string {\n",
     "  cardFooter?: CardFooter | null,\n): string {\n"],
    ["// What a caller must pass: the footer, or an explicit \"none\" with a reason.\nexport type FooterIntent =\n  | { footer: CardFooter }\n  | { footer: 'none'; reason: string }\nexport function NO_FOOTER(reason: string): FooterIntent {\n  return { footer: 'none', reason }\n}\n// The footer's html/text, or '' for an explicit none. Anything else — nothing\n// passed (a JS caller the build cannot check), a bare footer, a \"none\" with no\n// reason — throws rather than build an email that silently lacks its footer.\nfunction footerOf(intent: FooterIntent): CardFooter | null {\n  const f = (intent as { footer?: unknown } | null | undefined)?.footer\n  if (f === 'none') {\n    if (!String((intent as { reason?: unknown }).reason || '').trim()) throw new Error('email footer: NO_FOOTER needs a reason')\n    return null\n  }\n  if (f && typeof (f as CardFooter).html === 'string' && typeof (f as CardFooter).text === 'string') return f as CardFooter\n  throw new Error('email footer: say { footer } or NO_FOOTER(reason) — it cannot be left out')\n}\n\n",
     ""],
    ["  const cardFooterHtml = footerOf(cardFooter)?.html ?? ''\n",
     ""],
    ["  cardFooter: FooterIntent,\n",
     "  cardFooterHtml = '',\n"],
    ["// the finished document would land it after </html>, outside the frame.\n//\n// EVERY CALLER MUST SAY WHICH (2026-11-22, partner emails slice 3 fixes). The\n// footer used to be optional and default to nothing, so a caller that forgot\n// it got a finished-looking email with no unsubscribe link (the partner\n// editor's Preview did exactly that). Now the argument is REQUIRED and is one\n// of two things, so forgetting fails the build (and, for a JS caller, throws):\n//   { footer: CardFooter }               this email carries this footer\n//   NO_FOOTER('why this email has none') this email has none, and why\n// Client callers say what they always meant: drips, estimate follow-ups,\n// notifications and replies NO_FOOTER; the welcome and the job follow-ups\n// their footer. Nothing a client receives changed by one byte\n// (lib/network/client-email-bytes.test.ts).\n",
     "// the finished document would land it after </html>, outside the frame. The\n// caller passes it as `cardFooterHtml`; with no footer passed there is no\n// such row (drips never pass one).\n"],
  ],
}

/** The file with the footer-intent edits taken back out (unchanged if it had none). Throws if a piece is missing or doubled. */
export function withoutFooterIntent(file: string, src: string): string {
  let s = src
  for (const [piece, back] of FOOTER_INTENT_PIECES[file] || []) {
    const n = s.split(piece).length - 1
    if (n !== 1) throw new Error(`${file}: a footer-intent piece ${JSON.stringify(piece.slice(0, 60))} appears ${n} times, expected 1`)
    s = s.split(piece).join(back)
  }
  return s
}
