// lib/no-coverage-copy.ts
//
// The "we're not in your area yet" message itself — subject, HTML, plain text —
// and nothing else. PURE: no imports, no side effects, no server-only deps.
//
// It lives apart from lib/no-coverage-email (the send rail) for one reason: the
// confirm modal shows the operator a PREVIEW of what the person will receive,
// and a preview built from different source than the send is a preview that
// lies the moment either side is edited. Both now read this file. The send rail
// pulls in Resend + the service client, which must never reach a client bundle,
// so the copy had to come out rather than the modal reach in.
//
// COMPLIANCE POSTURE lives with the copy because it IS the copy: this first
// email is TRANSACTIONAL — the reply to an inquiry the person themselves
// submitted — so it needs no prior consent. Nothing here is pre-checked and
// nothing is subscribed by receiving it. The link states its own purpose
// plainly ("Join the list to hear when we reach your area"), and the CLICK is
// the consent act.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// First word of whatever name we hold; leads carry `name` and sometimes
// `first_name`. Null → an unnamed greeting rather than "Hi ,".
export function firstNameOf(
  lead: { first_name?: string | null; name?: string | null },
): string | null {
  const explicit = (lead.first_name || '').trim()
  if (explicit) return explicit.split(/\s+/)[0]
  const full = (lead.name || '').trim()
  if (full) return full.split(/\s+/)[0]
  return null
}

// The whole message, in both parts, from one place — so the modal's preview
// and the actual send can never drift (the modal renders the SUBJECT and the
// plain-text body this builds).
export function buildNoCoverageEmail(args: {
  optInUrl: string
  firstName?: string | null
  areaLabel?: string | null
}): { subject: string; html: string; text: string } {
  const { optInUrl, firstName, areaLabel } = args
  const greeting = firstName ? `Hi ${firstName},` : 'Hello,'
  // "your area" is the honest fallback — we only name a place when the intake
  // actually gave us one.
  const area = (areaLabel || '').trim()
  const areaPhrase = area ? `in ${area}` : 'in your area'

  const subject = "We're not in your area yet"

  const lines = [
    greeting,
    `Thank you for reaching out to Bee Organized. We wanted to get back to you personally: we don't have a location serving clients ${areaPhrase} right now, so we aren't able to take on your project.`,
    'We are still growing, and new locations open regularly.',
    'Join the list to hear when we reach your area. Clicking the link below is all it takes — there is nothing to fill in:',
    optInUrl,
    "If you'd rather not hear from us, simply ignore this email. We won't add you to anything unless you click.",
    'Thank you again for thinking of us.',
    '— The Bee Organized team',
  ]
  const text = lines.join('\n\n')

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f7f5f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a2e2b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f5f0;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;box-shadow:0 4px 24px rgba(26,46,43,0.08);overflow:hidden;">
            <tr>
              <td style="padding:32px 32px 24px;">
                <div style="font-size:32px;margin-bottom:8px;">🐝</div>
                <h1 style="margin:0 0 16px;font-family:Georgia,serif;font-size:22px;color:#1a2e2b;">We're not in your area yet</h1>
                <p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#1a2e2b;">${escapeHtml(greeting)}</p>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#1a2e2b;">
                  Thank you for reaching out to Bee Organized. We wanted to get back to you personally: we don't have a location serving clients ${escapeHtml(areaPhrase)} right now, so we aren't able to take on your project.
                </p>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#1a2e2b;">
                  We are still growing, and new locations open regularly.
                </p>
                <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#1a2e2b;">
                  <strong>Join the list to hear when we reach your area.</strong> Clicking the button below is all it takes &mdash; there is nothing to fill in.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">
                  <tr>
                    <td style="background:#1a2e2b;border-radius:10px;">
                      <a href="${optInUrl}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;font-family:inherit;">Join the list</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 8px;font-size:12px;color:#8a9e9a;">Or paste this link into your browser:</p>
                <p style="margin:0 0 20px;font-size:12px;color:#4a5e5a;word-break:break-all;font-family:ui-monospace,Menlo,monospace;">${escapeHtml(optInUrl)}</p>
                <p style="margin:0 0 16px;font-size:13px;line-height:1.55;color:#4a5e5a;">
                  If you'd rather not hear from us, simply ignore this email. We won't add you to anything unless you click.
                </p>
                <p style="margin:0;font-size:15px;line-height:1.55;color:#1a2e2b;">Thank you again for thinking of us.<br/>&mdash; The Bee Organized team</p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 24px;border-top:1px solid rgba(0,0,0,0.06);">
                <p style="margin:0;font-size:11px;color:#8a9e9a;">Sent by Bee Organized &middot; You're receiving this because you contacted us about an organizing project.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`

  return { subject, html, text }
}

// The plain-text body doubles as the modal's preview. Callers that only need
// the preview can drop `html`.
export type NoCoverageEmail = { subject: string; html: string; text: string }
