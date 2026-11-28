// lib/nurture-mailchimp.ts
// ─────────────────────────────────────────────────────────────
// FL-137/135: after an owner's 'in' (or the auto-close's) is saved by
// lib/nurture-choice.ts, send that one person to Mailchimp. A thin door onto
// addOneLeadToMailchimp (lib/mailchimp-sync.ts), which holds every lock: it
// re-reads the saved choice itself, so nothing can reach Mailchimp without
// one. Kept apart from nurture-choice.ts so the silent paths never load a
// sender.
// ─────────────────────────────────────────────────────────────

import { addOneLeadToMailchimp, type AddOneResult } from './mailchimp-sync'
import { mailchimpOpenFor } from './mailchimp-rollout'

/** Send one person whose Mailchimp choice is 'in'. Null where Mailchimp is not open (nothing tried). */
export async function sendChosenToMailchimp(leadId: string, locationUuid: string | null, deps: Parameters<typeof addOneLeadToMailchimp>[1] = {}): Promise<AddOneResult | null> {
  if (!mailchimpOpenFor(locationUuid)) return null
  return addOneLeadToMailchimp(leadId, deps)
}
