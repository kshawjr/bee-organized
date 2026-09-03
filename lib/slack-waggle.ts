// lib/slack-waggle.ts
// ─────────────────────────────────────────────────────────────
// The Waggle's transport: ONE Slack Incoming Webhook, bound at creation to
// #tech-updates-info (C0BTS6KGLNP) in the Bee Organized corporate
// workspace. A webhook carries its channel inside the URL, so nothing here
// names a channel — and nothing here can post anywhere else.
//
// WHY A SECOND WEBHOOK AND NOT THE OPS ONE. lib/slack.ts posts ops alerts
// through SLACK_WEBHOOK_URL, and a webhook is one URL = one channel. The
// release note goes to a different channel, so it is a different URL.
// Same shape, same never-throws contract, zero shared env vars — the two
// rails cannot cross by accident.
//
// WHY NOT THE PER-LOCATION BOT (lib/slack-bot.ts). That rail is an owner's
// OAuth grant into THEIR workspace. This is one channel in OUR workspace;
// a webhook Kevin creates once is the whole connection.
//
// SLACK_WAGGLE_WEBHOOK_URL: create at api.slack.com/apps → (any app Kevin
// owns that is installed in the corporate workspace) → Incoming Webhooks →
// Add New Webhook to Workspace → pick #tech-updates-info. Set in Vercel
// project settings (Production). Without it, publish still publishes to
// Help and reports { skipped: 'no_webhook_url' } — never a 500.
// ─────────────────────────────────────────────────────────────

export const WAGGLE_WEBHOOK_ENV = 'SLACK_WAGGLE_WEBHOOK_URL'

export type WagglePostResult = { ok: true } | { ok: false; skipped?: string; error?: string }

export async function postWaggleMessage(text: string, env: NodeJS.ProcessEnv = process.env): Promise<WagglePostResult> {
  const url = env[WAGGLE_WEBHOOK_ENV]
  if (!url) {
    console.warn(`[waggle] ${WAGGLE_WEBHOOK_ENV} not set — skipping post`)
    return { ok: false, skipped: 'no_webhook_url' }
  }
  const body = String(text ?? '').trim()
  if (!body) return { ok: false, skipped: 'empty_message' }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: body }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error('[waggle] post failed', res.status, detail.slice(0, 200))
      return { ok: false, error: `slack_http_${res.status}` }
    }
    return { ok: true }
  } catch (err: any) {
    console.error('[waggle] post threw', err?.message || err)
    return { ok: false, error: String(err?.message || err) }
  }
}

// One sentence for the editor when the post did not go.
export function wagglePostProblem(result: WagglePostResult): string | null {
  if (result.ok) return null
  if (result.skipped === 'no_webhook_url') return `The Slack link isn’t set up yet (${WAGGLE_WEBHOOK_ENV} is missing in Vercel).`
  if (result.skipped === 'empty_message') return 'The post was empty, so nothing was sent.'
  return `Slack didn’t accept the post (${result.error || 'unknown error'}).`
}
