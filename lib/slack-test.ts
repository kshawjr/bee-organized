// lib/slack-test.ts
// ─────────────────────────────────────────────────────────────
// The Slack TEST message (SlackCard "Send test message" button).
//
// One click → one plain-text post into the location's connected channel, so
// an owner can prove the whole path themselves — token, channel, bot access —
// without waiting for a real lead. For the locations whose owners picked a
// PRIVATE channel on Slack's own OAuth screen (the bot is never in it, every
// post dies channel_not_found), this is the button that finally makes that
// failure VISIBLE to the one person who can fix it, with words they can act
// on instead of a raw Slack error code.
//
// DELIBERATELY NOT A LEAD CARD. The message is plain text only — no
// attachments, no color stripe, no Block Kit, no buttons — so it cannot be
// mistaken for a lead notification at a glance or in a push preview, and it
// never carries the log_call interactivity contract. It says "test" in the
// first sentence.
//
// DELIBERATELY NOT LOGGED. The result is shown directly to the clicking
// owner; writing it to notification_log would feed the ops failure-alert
// rail (which reads slack failed rows) and pollute lead-send stats, so the
// route never calls logSlackNotification. A failed test alerts the OWNER on
// screen, not Kevin's ops channel.
//
// Both builders are pure so the copy is unit-testable without Slack.
// ─────────────────────────────────────────────────────────────

// What lands in the channel. Present tense, obviously a test, obviously
// nothing to do — and shaped nothing like the '🐝 New lead' card.
export function buildSlackTestMessage(locationName: string | null | undefined): { text: string } {
  const loc = locationName?.trim() ? ` for ${locationName.trim()}` : ''
  return {
    text:
      `🔔 This is a test message from Bee Hub${loc} — your Slack connection works. ` +
      `New lead alerts will arrive in this channel. No lead came in; there is nothing to do.`,
  }
}

// postToSlack failure → one sentence the OWNER can act on. Never a raw Slack
// error code on its own; the code rides along in parentheses for support.
export function slackTestFailureMessage(result: { skipped?: string; error?: string }): string {
  if (result.skipped === 'not_connected' || result.skipped === 'location_not_found') {
    return 'Slack isn’t connected for this location yet — click Add to Slack first.'
  }
  switch (result.error) {
    case 'channel_not_found':
    case 'not_in_channel':
      return (
        'The test didn’t arrive: Bee Hub can’t post to your channel. This usually means it’s a ' +
        'private channel — open Slack, go to that channel, type /invite and add the Bee Hub app, ' +
        'then try the test again. Or use Reconnect and pick a public channel.'
      )
    case 'is_archived':
      return 'The test didn’t arrive: your channel is archived in Slack. Use Reconnect and pick an active channel.'
    case 'invalid_auth':
    case 'token_revoked':
    case 'account_inactive':
      return (
        'The test didn’t arrive: your Slack connection is no longer valid (the app may have been ' +
        'removed from your workspace). Click Add to Slack to reconnect.'
      )
    default:
      return `The test didn’t arrive: Slack refused the message (${result.error || 'unknown error'}). Try Reconnect; if it keeps failing, contact support.`
  }
}
