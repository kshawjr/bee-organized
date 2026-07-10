// lib/slack.ts
// ─────────────────────────────────────────────────────────────
// Minimal Slack transport: posts to a Slack Incoming Webhook URL.
//
// SLACK_WEBHOOK_URL must be set in Vercel env vars (create an incoming
// webhook at api.slack.com/apps → Incoming Webhooks, pointed at the ops
// channel). Without it every post is a logged no-op — callers get
// { ok:false, skipped:'no_webhook_url' } and decide how loud to be.
// If we ever need threads/reactions/lookups, swap this for a bot token
// + chat.postMessage; the function signature can stay.
// ─────────────────────────────────────────────────────────────

export async function postSlackMessage(
  text: string,
): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  const url = process.env.SLACK_WEBHOOK_URL
  if (!url) {
    console.warn('[slack] SLACK_WEBHOOK_URL not set — skipping post')
    return { ok: false, skipped: 'no_webhook_url' }
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error('[slack] post failed', res.status, body.slice(0, 200))
      return { ok: false, error: `slack_http_${res.status}` }
    }
    return { ok: true }
  } catch (err: any) {
    console.error('[slack] post threw', err?.message || err)
    return { ok: false, error: String(err?.message || err) }
  }
}
