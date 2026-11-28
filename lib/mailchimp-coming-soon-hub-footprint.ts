// lib/mailchimp-coming-soon-hub-footprint.ts
// ─────────────────────────────────────────────────────────────
// Mailchimp "Coming soon" before roll-out (Kevin, 2026-11-27) changed
// components/BeeHub.jsx on purpose, in Settings only: the location's own id
// (locUuid) on the settings location, and an old ?section=mailchimp link
// showing Connections (with the greyed card) wherever Mailchimp is not open
// (lib/mailchimp-rollout.ts).
// Older tests pin BeeHub.jsx by fingerprint. They take THIS change back out
// first, by these exact pieces — each must be present exactly once, and the
// file with all of them put back is byte for byte origin/main e926171. So ANY
// other change still fails them. It is taken out before Mailchimp slice 6
// (mailchimp-send-hub-footprint.ts), whose first piece it sits inside.
//
// [what is there now, what main had].
// ─────────────────────────────────────────────────────────────

export const MAILCHIMP_COMING_SOON_HUB_PIECES: [string, string][] = [
 [
  "import MailchimpConnectionScreen from \"@/components/settings/MailchimpConnectionScreen\"\nimport { mailchimpOpenFor } from \"@/lib/mailchimp-rollout\"\n",
  "import MailchimpConnectionScreen from \"@/components/settings/MailchimpConnectionScreen\"\n"
 ],
 [
  "    locId:          '',\n    locUuid:        '',\n",
  "    locId:          '',\n"
 ],
 [
  "      locId:           currentLocationCtx.id,\n      locUuid:         currentLocationCtx.id || '',\n",
  "      locId:           currentLocationCtx.id,\n"
 ],
 [
  "    locId:          selectedLoc.locationId || selectedLoc.id,\n    locUuid:        selectedLoc.id || '',\n",
  "    locId:          selectedLoc.locationId || selectedLoc.id,\n"
 ],
 [
  "  const CONNECTION_SECTIONS = ownerConfig ? ['slack', 'jobber', 'mailchimp'] : []\n  // Mailchimp is open only where lib/mailchimp-rollout.ts says (Test Location,\n  // until roll-out). Anywhere else ?section=mailchimp shows the Connections\n  // page, where Mailchimp is the greyed \"Coming soon\" card — never the\n  // Mailchimp screen, and never the no-access notice (which says the owner\n  // manages it).\n  const mailchimpOpen = mailchimpOpenFor(settings.location.locUuid)\n  const mailchimpShut = activeSection === 'mailchimp' && !mailchimpOpen\n",
  "  const CONNECTION_SECTIONS = ownerConfig ? ['slack', 'jobber', 'mailchimp'] : []\n"
 ],
 [
  "background:(sectionAllowed && (mailchimpShut || SUI.REBUILT_SECTIONS.includes(activeSection))) ? SUI.PAGE_BG",
  "background:(sectionAllowed && SUI.REBUILT_SECTIONS.includes(activeSection)) ? SUI.PAGE_BG"
 ],
 [
  "        {(activeSection==='connections' || mailchimpShut)&&(\n",
  "        {activeSection==='connections'&&(\n"
 ],
 [
  "        {CONNECTION_SECTIONS.includes(activeSection) && !mailchimpShut &&(\n",
  "        {CONNECTION_SECTIONS.includes(activeSection)&&(\n"
 ],
 [
  "        {activeSection==='mailchimp' && mailchimpOpen &&(\n",
  "        {activeSection==='mailchimp'&&(\n"
 ]
]

/** BeeHub.jsx with the Mailchimp "Coming soon" change taken back out. Throws if a piece is missing or doubled. */
export function withoutMailchimpComingSoon(src: string): string {
  let s = src
  for (const [piece, back] of MAILCHIMP_COMING_SOON_HUB_PIECES) {
    const n = s.split(piece).length - 1
    if (n !== 1) throw new Error(`BeeHub.jsx: a Mailchimp "Coming soon" piece ${JSON.stringify(piece.slice(0, 60))} appears ${n} times, expected 1`)
    s = s.split(piece).join(back)
  }
  return s
}
