// lib/email-switches.ts
//
// The PURE half of lib/email-send-options.ts — no database, safe to import in
// the browser (the Emails screen's preview uses the same rule a send does).
// The reasoning lives in lib/email-send-options.ts.

export const RATE_TAG = '{{rate_per_hour}}'
// Every tag that asks the client to click a scheduling link.
export const BOOKING_LINK_TAGS = [
  '{{owner_booking_link}}',
  '{{booking_link}}',
  '{{book_assessment_link}}',
  '{{discovery_booking_link}}',
  '{{virtual_booking_link}}',
] as const

export const quotesRate = (s: string | null | undefined) => !!s && s.includes(RATE_TAG)
export const asksForBookingLink = (s: string | null | undefined) =>
  !!s && BOOKING_LINK_TAGS.some((t) => s.includes(t))

// Take out every SENTENCE that contains one of the tags. Sentences end at
// . ! or ? followed by a space or a line end; a "sentence" with no ending
// punctuation runs to the end of its line. A paragraph left empty is dropped
// with its blank line, so nothing reads as a gap.
//
// The master first email's pricing paragraph reads
//   "Following the assessment, we'll be able to provide an estimate of time
//    and associated costs. Our rate starts at {{rate_per_hour}} per hour per
//    Bee. We will source and bring recommended products…"
// and without its middle sentence it still reads naturally: the estimate
// sentence already says costs come after the assessment. Kevin sees the email
// both ways before this goes live.
export function stripTaggedSentences(text: string, tags: readonly string[]): string {
  const has = (s: string) => tags.some((t) => s.includes(t))
  if (!has(text)) return text
  // A sentence ends at . ! or ? FOLLOWED BY whitespace, so the dot inside
  // "beeorganized.com" or "$95.50" never splits one.
  const stripLine = (line: string) =>
    line.split(/(?<=[.!?])\s+/).filter((sentence) => !has(sentence)).join(' ')
  const out: string[] = []
  for (const para of text.split(/\n{2,}/)) {
    const kept: string[] = []
    for (const line of para.split('\n')) {
      if (!has(line)) { kept.push(line); continue }
      const left = stripLine(line)
      if (left.trim()) kept.push(left)
    }
    if (kept.join('').trim()) out.push(kept.join('\n'))
  }
  return out.join('\n\n')
}

export type ContentDecision =
  | { action: 'send'; subject: string | null; body: string; buttonLink: string | null; changed: boolean }
  | { action: 'skip'; reason: 'rate_not_shown' | 'booking_links_not_used' }

// THE rule, applied to the template SOURCE before rendering (so the existing
// hold guards then look at what will actually be sent: a stripped sentence
// can no longer hold anything).
export function applyEmailSwitches(input: {
  alwaysSends: boolean
  options: { showsHourlyRate: boolean; usesBookingLinks: boolean }
  subject: string | null
  body: string
  buttonLink: string | null
}): ContentDecision {
  let { subject, body, buttonLink } = input
  let changed = false
  const all = () => `${subject ?? ''}\n${body}\n${buttonLink ?? ''}`
  if (!input.options.showsHourlyRate && quotesRate(all())) {
    if (!input.alwaysSends) return { action: 'skip', reason: 'rate_not_shown' }
    body = stripTaggedSentences(body, [RATE_TAG])
    subject = subject == null ? subject : stripTaggedSentences(subject, [RATE_TAG])
    if (quotesRate(buttonLink)) buttonLink = null
    changed = true
  }
  if (!input.options.usesBookingLinks && asksForBookingLink(all())) {
    if (!input.alwaysSends) return { action: 'skip', reason: 'booking_links_not_used' }
    body = stripTaggedSentences(body, BOOKING_LINK_TAGS)
    subject = subject == null ? subject : stripTaggedSentences(subject, BOOKING_LINK_TAGS)
    if (asksForBookingLink(buttonLink)) buttonLink = null
    changed = true
  }
  return { action: 'send', subject, body, buttonLink, changed }
}
