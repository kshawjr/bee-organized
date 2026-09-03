// lib/feedback-intake.ts
//
// The guided intake — design A. Three doors, then three questions one screen
// at a time, then a review. Server-safe (no React) so the modal, the ask strip
// and the tests read ONE definition of what is asked and how it is stored.
//
// THE SCHEMA DECISION. Answer 1 is the title. Answers 2 and 3 are folded into
// the description under fixed headings. No new column, no jsonb.
//
// Why: everything that reads a report today reads `description` — the triage
// list and modal (whiteSpace: pre-wrap), the owner screen, the composer's My
// Items card, the search box, the Monday brief, the name extractor, and the
// reply email's excerpt. A column or a jsonb field would be invisible to every
// one of those until each was taught about it, and an existing entry would
// render one way while a new one rendered another. Folding means a headed
// answer renders correctly everywhere on day one and an old entry is untouched,
// because nothing about the column changed. The cost is that the headings are
// a convention, not a structure: they can be split back apart by matching the
// fixed strings below, but the database does not guarantee it. That is the
// right trade for a form whose reader is a person.

export type IntakeType = 'bug' | 'question' | 'feature'

export type IntakeQuestion = {
  key: 'q1' | 'q2' | 'q3'
  prompt: string
  hint?: string
  placeholder: string
  // one line (an <input>, becomes the title) or a paragraph (<textarea>)
  kind: 'line' | 'paragraph'
  optional?: boolean
  maxLength: number
  // Bug answer 2 offers the screenshot slot right there, where the evidence is.
  screenshot?: boolean
  // The heading the answer is stored under (answers 2 and 3 only).
  heading?: string
}

// The three doors. Label is what an owner taps; the type is what the
// database already accepts (VALID_TYPES in app/api/feedback/route.ts —
// unchanged, and not imported here on purpose, see lib/feedback-types.ts).
export const INTAKE_DOORS: Array<{ type: IntakeType; icon: string; label: string; blurb: string }> = [
  { type: 'bug',      icon: '🐛', label: 'Report a bug',       blurb: 'Something isn’t working the way it should.' },
  { type: 'question', icon: '❓', label: 'Ask a question',     blurb: 'You want to know how to do something.' },
  { type: 'feature',  icon: '✨', label: 'Suggest a feature',  blurb: 'Something that would make the work easier.' },
]

export function isIntakeType(t: unknown): t is IntakeType {
  return t === 'bug' || t === 'question' || t === 'feature'
}

// Title stays within the route's 100; description within its 2000 —
// 1100 + 600 + two headings + an optional "About:" line fits with room.
export const INTAKE_QUESTIONS: Record<IntakeType, IntakeQuestion[]> = {
  bug: [
    { key: 'q1', prompt: 'What went wrong?', hint: 'One line — the headline.', placeholder: 'e.g. Texts to a client aren’t sending', kind: 'line', maxLength: 100 },
    { key: 'q2', prompt: 'What did you expect, and what happened instead?', hint: 'A screenshot helps more than anything.', placeholder: 'I tapped Send and expected… but instead…', kind: 'paragraph', maxLength: 1100, screenshot: true, heading: 'What I expected, and what happened instead:' },
    { key: 'q3', prompt: 'Where were you?', hint: 'A client name, a screen, anything that helps us find it.', placeholder: 'e.g. On Dana Whitfield’s record, the Emails tab', kind: 'paragraph', maxLength: 600, heading: 'Where I was:' },
  ],
  question: [
    { key: 'q1', prompt: 'What do you want to know?', hint: 'One line.', placeholder: 'e.g. How do I move a lead to another person?', kind: 'line', maxLength: 100 },
    { key: 'q2', prompt: 'What are you trying to do?', hint: 'The job behind the question — it changes the answer.', placeholder: 'I’m trying to…', kind: 'paragraph', maxLength: 1100, heading: 'What I’m trying to do:' },
    { key: 'q3', prompt: 'Anything else?', hint: 'Optional.', placeholder: 'What you’ve already tried, or anything else', kind: 'paragraph', maxLength: 600, optional: true, heading: 'Anything else:' },
  ],
  feature: [
    { key: 'q1', prompt: 'What would you like to be able to do?', hint: 'One line.', placeholder: 'e.g. Text a client straight from their record', kind: 'line', maxLength: 100 },
    { key: 'q2', prompt: 'What would that save you?', hint: 'Time, a mistake, a round trip — this is the part that tells us whether to build it.', placeholder: 'Right now it costs me…', kind: 'paragraph', maxLength: 1100, heading: 'What it would save me:' },
    { key: 'q3', prompt: 'How do you handle it today?', hint: 'Optional.', placeholder: 'Today I…', kind: 'paragraph', maxLength: 600, optional: true, heading: 'How I handle it today:' },
  ],
}

export type IntakeAnswers = { q1?: string; q2?: string; q3?: string }

// The stored description: answers 2 and 3 under their headings, an empty
// optional answer omitted, and the Help breadcrumb (if the ask came from
// the ask strip) as a last "About:" line so triage sees it in words.
export function composeDescription(type: IntakeType, answers: IntakeAnswers, about?: string | null): string {
  const qs = INTAKE_QUESTIONS[type]
  const blocks: string[] = []
  for (const q of qs) {
    if (q.key === 'q1') continue
    const a = String(answers[q.key] ?? '').trim()
    if (!a) continue
    blocks.push(`${q.heading}\n${a}`)
  }
  const aboutLine = String(about ?? '').trim()
  if (aboutLine) blocks.push(`About: ${aboutLine.slice(0, 160)}`)
  return blocks.join('\n\n').slice(0, 2000)
}

// Which required answers are still missing — the review step's gate, and
// the Next button's. Returns the question keys, in order.
export function missingAnswers(type: IntakeType, answers: IntakeAnswers): Array<IntakeQuestion['key']> {
  return INTAKE_QUESTIONS[type].filter(q => !q.optional && !String(answers[q.key] ?? '').trim()).map(q => q.key)
}

// ── device — the one context key the app did not capture ─────────────
// A fixed vocabulary, never the raw user-agent string (the id-only rule in
// lib/feedback-context applies: fixed labels, no free text). null for a
// browser this cannot place, so no key is written rather than a guess.
export const DEVICE_LABELS = ['iPhone', 'iPad', 'Android', 'Mac', 'Windows'] as const
export type DeviceLabel = (typeof DEVICE_LABELS)[number]

export function deviceLabel(userAgent: unknown, maxTouchPoints?: unknown): DeviceLabel | null {
  const ua = String(userAgent ?? '')
  if (!ua) return null
  if (/iPhone/i.test(ua)) return 'iPhone'
  if (/iPad/i.test(ua)) return 'iPad'
  if (/Android/i.test(ua)) return 'Android'
  // iPadOS 13+ reports itself as a Mac; touch points tell it apart.
  if (/Macintosh/i.test(ua)) return Number(maxTouchPoints) > 1 ? 'iPad' : 'Mac'
  if (/Windows/i.test(ua)) return 'Windows'
  return null
}

// "Sent from Clients on an iPhone" — the context line shown instead of a
// "where were you" field. Built only from what is actually known.
export function contextSentence(ctx: { screen?: string | null; device?: string | null } | null | undefined): string | null {
  const screen = String(ctx?.screen ?? '').trim()
  const device = String(ctx?.device ?? '').trim()
  if (!screen && !device) return null
  const article = /^[AEIOUaeiou]/.test(device) ? 'an' : 'a'
  if (screen && device) return `Sent from ${screen} on ${article} ${device}`
  if (screen) return `Sent from ${screen}`
  return `Sent from ${article} ${device}`
}
