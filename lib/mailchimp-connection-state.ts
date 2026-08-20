// lib/mailchimp-connection-state.ts
// ─────────────────────────────────────────────────────────────────────────────
// SINGLE source of truth for the three states the Mailchimp card renders, and
// the owner-facing words for each. Pure — no React, no DOM, no secrets — for
// the same reason lib/jobber-status.ts is: the Jobber card's whole bug history
// came from DRIFTING copies of a derivation that lived inside a component.
//
// The three states, and what makes each one true:
//
//   not_connected   — no Mailchimp account is linked. Offer Connect.
//   needs_audience  — an account IS linked but no audience is chosen. This is
//                     the state the callback deliberately lands in, and it is
//                     the one that must not read as finished: a location here
//                     has a live token and no destination.
//   ready           — account + audience both chosen.
//
// ── WHY sync_live IS NOT AN INPUT ───────────────────────────────────────────
// mailchimp_sync_live is FALSE for every location and is turned on by hand,
// per location, exactly like notifications_live. It is deliberately absent from
// this module's inputs so that no owner-facing copy can ever be derived from
// it — a card that said "syncing" or "paused" would be describing a switch the
// owner cannot see and did not set. "ready" here means "set up", never
// "sending".
//
// The COPY lives here rather than in the component so the words are assertable
// without mounting anything, and so the three states cannot each grow their own
// tone in a JSX branch. Sentence case throughout, owner language: no "OAuth",
// no "list id", no "server prefix", no "token".
// ─────────────────────────────────────────────────────────────────────────────

export type MailchimpState = 'not_connected' | 'needs_audience' | 'ready'

export interface MailchimpStateInput {
  connected?: boolean | null
  accountName?: string | null
  listId?: string | null
  listName?: string | null
}

export function deriveMailchimpState({
  connected,
  listId,
}: MailchimpStateInput = {}): MailchimpState {
  if (!connected) return 'not_connected'
  // The audience is what makes the setup finished. An empty string counts as
  // unset — a blank id would otherwise present as a chosen audience with no name.
  if (!listId) return 'needs_audience'
  return 'ready'
}

export interface MailchimpCopy {
  // The status word beside the heading.
  badge: string
  headline: string
  body: string
}

// One place, one voice. Each body answers "what is true now" and, when
// something is outstanding, "what you do next" — and never promises a send,
// because nothing sends in this step.
export function mailchimpCopy(state: MailchimpState, accountName?: string | null): MailchimpCopy {
  const account = (accountName || '').trim()

  if (state === 'not_connected') {
    return {
      badge: 'Not connected',
      headline: 'Connect Mailchimp',
      body: 'Link your Mailchimp account so you can choose which audience your clients belong to.',
    }
  }

  if (state === 'needs_audience') {
    return {
      badge: 'Finish setting up',
      headline: 'Choose an audience',
      // Names the account so an owner with several can see which one they
      // linked, and says plainly that this is not done yet.
      body: account
        ? `Your ${account} account is connected. Choose the audience your clients belong to to finish setting up.`
        : 'Your Mailchimp account is connected. Choose the audience your clients belong to to finish setting up.',
    }
  }

  return {
    badge: 'Connected',
    headline: 'Mailchimp is connected',
    body: 'Your account and audience are saved. Nothing is being sent to Mailchimp yet.',
  }
}

// The empty-account case is its own message, not an empty dropdown. An owner
// who has never made an audience needs to be told where to go, and told that
// this screen is not broken.
export const NO_AUDIENCES_COPY =
  'This Mailchimp account has no audiences yet. Create one in Mailchimp, then come back and refresh this page.'
