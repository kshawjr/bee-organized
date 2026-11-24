// app/unsubscribe/[token]/confirm/route.ts
//
// POST /unsubscribe/<token>/confirm — the "Unsubscribe me" button on the
// unsubscribe page. The ONLY place a person's own unsubscribe is recorded:
//   a REFERRAL PARTNER's (64-hex key, partner emails slice 2), and
//   a CLIENT's (48-hex key, FL-75 slice 2 — before that slice, opening a
//   client's link unsubscribed on open).
// The two keys can never be confused, and each goes only to its own list:
// a partner's to partner_unsubscribes, a client's to the shared no-marketing
// list (by the database trigger on the lead record).
//
// WHY A BUTTON AND A POST: mail programs and security scanners open every
// link in an email (and link previews and prefetches do too). If opening the
// link unsubscribed, a scanner would unsubscribe partners who never asked.
// So the page (app/unsubscribe/[token]/page.tsx) only reads, and asks; this
// handler — POST only — does it. There is no GET or HEAD here: Next answers
// those with 405 and nothing is run. There is no "?confirm=1" shortcut.
//
// WHAT COUNTS AS A PRESS: a form body with confirm=yes (our button), or
// List-Unsubscribe=One-Click — the RFC 8058 one-click POST a mail provider
// sends when the person presses its own Unsubscribe button, IF a later slice
// adds List-Unsubscribe + List-Unsubscribe-Post headers pointing here. Both
// are a person's deliberate act. Anything else (an empty POST, a stray
// request) is refused with 400 and changes nothing.
//
// The token is the path, so a request has to carry the key from the email.

import { NextRequest, NextResponse } from 'next/server'
import { consumePartnerUnsubscribeToken, PARTNER_TOKEN_PATTERN } from '@/lib/network/partner-unsubscribe'
import { consumeClientUnsubscribe, CLIENT_TOKEN_PATTERN } from '@/lib/client-unsubscribe'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const token = params?.token || ''
  const isClient = CLIENT_TOKEN_PATTERN.test(token)
  if (!isClient && !PARTNER_TOKEN_PATTERN.test(token)) {
    return new NextResponse('This link is no longer active.', { status: 404 })
  }

  let form: URLSearchParams
  try {
    form = new URLSearchParams(await req.text())
  } catch {
    form = new URLSearchParams()
  }
  const button = form.get('confirm') === 'yes'
  const oneClick = form.get('List-Unsubscribe') === 'One-Click'
  if (!button && !oneClick) {
    return new NextResponse('Nothing was changed.', { status: 400 })
  }

  const result = isClient ? await consumeClientUnsubscribe(token) : await consumePartnerUnsubscribeToken(token)
  if (oneClick) {
    // A mail provider, not a browser: a plain answer, no page.
    return new NextResponse(result.outcome === 'failed' ? 'Failed' : 'OK', { status: result.outcome === 'failed' ? 500 : 200 })
  }
  // Back to the page, which now reads "You're unsubscribed" (or, on a
  // failure, asks again with an honest message). 303: the browser follows
  // with a GET, so a refresh never posts twice.
  const back = new URL(`/unsubscribe/${encodeURIComponent(token)}${result.outcome === 'failed' ? '?error=1' : ''}`, req.url)
  return NextResponse.redirect(back, 303)
}
