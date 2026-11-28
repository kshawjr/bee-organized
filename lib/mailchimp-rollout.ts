// lib/mailchimp-rollout.ts
//
// WHO MAY USE THE MAILCHIMP CONNECTION BEFORE ROLL-OUT (Kevin, 2026-11-27):
// "until roll-out, Settings > Connections > Mailchimp is greyed out with a
// 'Coming soon' label for every location except Test Location. Owners can't
// connect, choose a list, or start the set-up."
//
// One list, by the location's own id (locations.id), so a renamed location
// can never slip in. Everyone else — Chattanooga, and Orlando and Southwest
// Austin with their half-finished connections — sees the greyed card. Their
// connection rows are not touched: greying is on screen only.
//
// To roll out: add a location's id here (or retire this file and the two
// places that ask it: components/settings/ConnectionsPage.jsx and the
// CONNECTION_SECTIONS line in components/BeeHub.jsx).

export const MAILCHIMP_OPEN_LOCATIONS: Readonly<Record<string, string>> = {
  'a8fe17f6-fd16-4ed3-8730-550a65d69ad6': 'Test Location',
}

export function mailchimpOpenFor(locationUuid: unknown): boolean {
  return typeof locationUuid === 'string' && Object.prototype.hasOwnProperty.call(MAILCHIMP_OPEN_LOCATIONS, locationUuid)
}

// The card's one line while it is greyed: what it WILL do, like the other
// roadmap cards.
export const MAILCHIMP_SOON_DESC = 'Keep your Mailchimp audience and your clients in step.'
