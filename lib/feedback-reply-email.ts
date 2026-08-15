// lib/feedback-reply-email.ts
//
// "Someone replied to the thing you reported." Issue 233.
//
// THE PROBLEM THIS CLOSES. The triage modal's reply box has always been
// labelled "shown to the submitter on their item" — and nothing was ever sent.
// The only route to a reply was a My Items tab reachable from a footer link
// inside the help panel, which nobody had a reason to open. Forty-seven replies
// were written into production and delivered to no one. One owner has been
// answered thirty-one times and told zero times.
//
// WHY sendEmailDirect AND NOT sendEmail — the lib/no-coverage-email reasoning,
// both halves of it:
//
//   1. VOICE. This message is Bee Organized answering a support report. It is
//      NOT the franchise corresponding with their own customers, which is the
//      entire job of sendEmail's per-location sender. Sending a reply to the
//      Palm Beach owner FROM the Palm Beach sender identity would read as their
//      own office writing to them.
//   2. OBSERVABILITY. sendEmail's three pre-send guards (missing arg, location
//      lookup failed, location missing sender config) all return BEFORE
//      sendEmailDirect, and sendEmailDirect is the only place notification_log
//      is written. A reply that died in one of those guards would vanish. The
//      submitter's location may be null (feedback_items.location_id is
//      nullable), so that is a live failure mode here, not a theoretical one.
//
// notification_log: recorded, and recorded FOR FREE — logging is hooked inside
// sendEmailDirect, so this rail is in the notebook by construction like every
// other send. email_kind is 'feedback_reply' (the column is unconstrained TEXT
// — no CHECK to widen, no migration needed) and location_id carries the item's
// location so a per-franchise view of outbound mail stays complete.
//
// AUDIENCE. A 45-65 non-technical franchise owner. No product vocabulary, no
// status jargon in the lede, no "your ticket has been updated". One idea per
// line: someone answered you, here is what they said, here is where to look.
//
// TWO BUILDS, ONE RAIL (issue 236). Marking an item Fixed now notifies the
// submitter whether or not anyone wrote a sentence, so this module builds a
// second shape: the announcement, which has no reply to quote. It is the same
// module, the same sender, the same notification_log kind and the same
// never-throws send — the only thing that forks is the copy, because an email
// that says "What we said back:" above an empty box would be worse than the
// silence it replaces.

import { sendEmailDirect } from './resend'
import type { SendResult } from './resend'
import {
  buildBrandedShellHtml,
  escHtml,
  escAttr,
  DRIP_BRAND_TEAL,
  DRIP_WEBSITE_URL,
  DRIP_WEBSITE_LABEL,
} from './drip-email-layout'

// The same corporate sender trio as the invite rail and no-coverage — the one
// Resend-verified identity that isn't tied to a location.
const FROM_EMAIL = process.env.INVITE_FROM_EMAIL || 'admin@beeorganized.com'
const FROM_NAME = process.env.INVITE_FROM_NAME || 'Bee Organized'
const REPLY_TO = process.env.INVITE_REPLY_TO_EMAIL || 'admin@beeorganized.com'

export const FEEDBACK_REPLY_EMAIL_KIND = 'feedback_reply'

// Where the link lands. `?feedback=1` opens the My Items list on top of
// whatever screen the app restores — the one surface that already renders a
// reply AS a reply, and the one that works for every role rather than only the
// owner/manager nav. Absolute, because a relative href in an email is dead.
export function feedbackReplyLink(env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.NEXT_PUBLIC_APP_URL || env.NEXT_PUBLIC_SITE_URL || '').replace(/\/+$/, '')
  return base ? `${base}/?feedback=1` : ''
}

export function firstNameOf(name: string | null | undefined): string | null {
  const trimmed = String(name || '').trim()
  if (!trimmed) return null
  // An email address in the name slot is not a name — better a warm greeting
  // with no name than "Hi lynette.ewy@gmail.com,".
  if (trimmed.includes('@')) return null
  return trimmed.split(/\s+/)[0] || null
}

export interface FeedbackReplyEmailArgs {
  /** Submitter's display name; the greeting degrades to "Hi there," without one. */
  recipientName?: string | null
  /** The title they gave the report. */
  itemTitle: string
  /** 'bug' | 'feature' — only shifts one noun ("problem" vs "idea"). */
  itemType?: string | null
  /** The reply text exactly as typed in triage. Empty for a bare Fixed announcement. */
  replyText: string
  /**
   * Plain-word status, ONLY when the status moved in the same save. Null when
   * the reply came on its own — see the route: a status change with no new
   * reply sends nothing at all, and a reply with no status change should not
   * invent a status line to fill space.
   */
  statusLabel?: string | null
  /**
   * This send exists BECAUSE the item just shipped (issue 236). With reply text
   * it changes nothing — the reply leads, and the status line already names
   * "Fixed". With NO reply text it selects the announcement build below.
   */
  shipped?: boolean
  link?: string
}

export interface BuiltEmail {
  subject: string
  html: string
  text: string
}

// Pure builder — no I/O, no env beyond the link default, so the copy is
// testable without touching Resend.
export function buildFeedbackReplyEmail(args: FeedbackReplyEmailArgs): BuiltEmail {
  const link = args.link ?? feedbackReplyLink()
  const first = firstNameOf(args.recipientName)
  const greeting = first ? `Hi ${first},` : 'Hi there,'
  const feature = args.itemType === 'feature'
  const noun = feature ? 'idea' : 'report'
  const title = String(args.itemTitle || '').trim() || 'your feedback'
  const reply = String(args.replyText || '').trim()

  // ── THE ANNOUNCEMENT BUILD (issue 236) ──────────────────────────
  // Marking something Fixed sends even when nobody wrote a sentence, so this
  // email has to work with NO words to quote. It therefore says the one thing
  // it actually knows — the thing you reported is done — and drops the "What we
  // said back:" block entirely rather than quoting an empty rule, and drops the
  // status line too, because "We've also marked it: Fixed" is not an ALSO when
  // it is the entire message.
  //
  // The verb forks where the on-screen pill does not: the owner screen shows one
  // "Fixed" pill for both types, but "We fixed 'A way to export the list'" is
  // the wrong sentence about a request that was BUILT.
  const announceOnly = !reply && !!args.shipped
  const verb = feature ? 'built' : 'fixed'

  // Subject carries their own words back to them — an owner with several open
  // reports can tell which one this is from the inbox list alone.
  const shortTitle = title.length > 60 ? `${title.slice(0, 57)}…` : title
  const subject = announceOnly
    ? `We ${verb} "${shortTitle}"`
    : `We replied about "${shortTitle}"`

  const lede = announceOnly
    ? (feature
        ? 'Good news — the idea you sent in is built, and it is live in Bee Hub now.'
        : 'Good news — the problem you reported is fixed, and the fix is live in Bee Hub now.')
    : `Someone on the Bee Organized team has replied to the ${noun} you sent in.`

  // The invitation to push back. It matters more here than under a reply: a
  // reply is a person you can answer, whereas this arrives unattended, and the
  // claim it makes ("it's fixed") is one the reader is the first to be able to
  // check.
  const closing = announceOnly
    ? 'Everything you’ve sent us is in Bee Hub under Feedback. If it still doesn’t look right on your end, just reply to this email and tell us — we would rather hear it twice than not at all.'
    : "Everything you've sent us — and anything we've said back — is in Bee Hub under Feedback. Just reply to this email if you'd like to tell us more."

  const statusLine = !announceOnly && args.statusLabel
    ? `We've also marked it: ${args.statusLabel}.`
    : null

  // ── HTML ────────────────────────────────────────────────────────
  const P = 'margin:0 0 14px;font-size:16px;line-height:1.7;color:#2b2b28;'
  const quoteBlock = reply
    .split(/\n{2,}/)
    .map(para => `<p style="margin:0 0 10px;font-size:16px;line-height:1.7;color:#2b2b28;">${escHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('')

  // Present only when there are words to present. This is the difference
  // between the two builds.
  const quotedReplyHtml = announceOnly ? '' : `<p style="margin:0 0 10px;font-size:13px;line-height:1.5;color:#61615C;">What we said back:</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">
                <tr>
                  <td style="border-left:3px solid ${DRIP_BRAND_TEAL};padding:2px 0 2px 16px;">
                    ${quoteBlock}
                  </td>
                </tr>
              </table>`

  const cardContentHtml = `<p style="${P}">${escHtml(greeting)}</p>
              <p style="${P}">${escHtml(lede)}</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">
                <tr>
                  <td style="background:#f7f6f4;border-radius:6px;padding:16px 18px;">
                    <p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:#61615C;">You told us:</p>
                    <p style="margin:0;font-size:16px;line-height:1.6;color:#2b2b28;font-weight:600;">${escHtml(title)}</p>
                  </td>
                </tr>
              </table>
              ${quotedReplyHtml}
              ${statusLine ? `<p style="${P}">${escHtml(statusLine)}</p>` : ''}
              ${link ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">
                <tr>
                  <td align="center" bgcolor="${DRIP_BRAND_TEAL}" style="background:${DRIP_BRAND_TEAL};border-radius:6px;">
                    <a href="${escAttr(link)}" style="display:inline-block;padding:13px 26px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;">See it in Bee Hub</a>
                  </td>
                </tr>
              </table>` : ''}
              <p style="margin:0;font-size:15px;line-height:1.7;color:#61615C;">${escHtml(closing)}</p>`

  const footerInner = `Bee Organized&nbsp;&nbsp;|&nbsp;&nbsp;<a href="${DRIP_WEBSITE_URL}" style="color:#ffffff;text-decoration:underline;">${DRIP_WEBSITE_LABEL}</a>`

  const html = buildBrandedShellHtml(cardContentHtml, footerInner)

  // ── plain text ──────────────────────────────────────────────────
  const text = [
    greeting,
    '',
    lede,
    '',
    'You told us:',
    title,
    ...(announceOnly ? [] : ['', 'What we said back:', reply]),
    ...(statusLine ? ['', statusLine] : []),
    ...(link ? ['', `See it in Bee Hub: ${link}`] : []),
    '',
    closing,
    '',
    'Bee Organized',
    DRIP_WEBSITE_URL,
  ].join('\n')

  return { subject, html, text }
}

// The send. Returns sendEmailDirect's SendResult plus the built subject, so the
// caller can report what was (or wasn't) sent without rebuilding the copy.
//
// NEVER THROWS AND NEVER BLOCKS THE SAVE. The caller has already written the
// reply to the database by the time this runs; a mail failure must leave the
// triage write intact and be REPORTED, not swallowed and not escalated into a
// 500 that makes an admin retype their reply into a row that already has it.
export async function sendFeedbackReplyEmail(args: FeedbackReplyEmailArgs & {
  to: string
  locationId?: string | null
}): Promise<SendResult & { subject: string }> {
  const { subject, html, text } = buildFeedbackReplyEmail(args)
  try {
    const result = await sendEmailDirect({
      from: FROM_EMAIL,
      fromName: FROM_NAME,
      replyTo: REPLY_TO,
      to: args.to,
      subject,
      html,
      text,
      // Context colours the notification_log row and nothing else. No lead_id —
      // a feedback item is not a lead, even when it was filed from one.
      location_id: args.locationId ?? null,
      email_kind: FEEDBACK_REPLY_EMAIL_KIND,
    })
    return { ...result, subject }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'feedback reply send threw'
    console.error('[feedback reply email]', message)
    return { success: false, error: message, subject }
  }
}
