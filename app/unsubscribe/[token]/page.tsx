// app/unsubscribe/[token]/page.tsx
//
// The public unsubscribe landing page — where a marketing email's footer link
// lands. Mirrors the opt-in page (app/mailing-list/[token]) beat for beat: a
// server component looks the token up through the SERVICE role (the click is
// anonymous — there is no session to scope by) and branches on state. The URL
// carries the token and NOTHING else — no lead id, no email, no PII.
//
// OPENING THE LINK ONLY READS — for clients too, from FL-75 slice 2
// (2026-11-23). Mail programs, security scanners, link previews and
// prefetches open every link in an email. Until this slice a client's link
// unsubscribed on open; now a client's no stops marketing at EVERY location
// by address (the shared no-marketing list), so an open by a scanner would
// do far more harm. The page asks "Stop receiving marketing emails?"; only
// the button — a POST to ./confirm — unsubscribes (lib/client-unsubscribe.ts).
// Every later visit after a press shows the same confirmation.
//
// NO EXPIRY STATE — the deliberate difference from the opt-in page. Expiry
// there bounds the window a leaked link can CREATE a consent record. Here the
// only thing the link can do is stop us emailing someone, and that must work
// from a year-old forwarded message just as well as from today's. CAN-SPAM
// requires the mechanism to keep working; a link that says "expired" to a
// person trying to leave is a compliance failure, so leads.unsubscribe_token
// has no expiry column at all (see migrations/marketing_unsubscribe.sql).
//
// ONE INVERSION of the opt-in page's failure posture, on purpose. There, a
// failed consent WRITE still renders the confirmation: an unrecorded consent
// is treated as no consent, so the error runs the safe direction (we
// under-send). Here the directions flip — telling a person "you're
// unsubscribed" when the write failed means they may KEEP GETTING EMAIL,
// which is the exact harm they clicked to end. So a failed withdrawal write
// renders an honest "we couldn't process this" state with a human fallback
// (reply to any email), never a false confirmation.
//
// NOT under /api: a human-facing page at a human-facing route. middleware.ts
// needs no change — it only enforces the disabled-hub_user lockout, and an
// anonymous visitor passes straight through.

import { clientUnsubscribeStatus } from '@/lib/client-unsubscribe'
import { partnerUnsubscribeStatus } from '@/lib/network/partner-unsubscribe'
import { partnerGreetingName } from '@/lib/network/partner-greeting'
import type { ReactNode } from 'react'

export const runtime = 'nodejs'
// Never statically render or cache: per-token state.
export const dynamic = 'force-dynamic'

type Props = { params: { token: string }; searchParams?: { error?: string } }

export default async function UnsubscribePage({ params, searchParams }: Props) {
  const token = params?.token || ''

  if (!token) {
    return <Shell title="This link is no longer active" body={INACTIVE_BODY} />
  }

  // Reads only (one SELECT). Unknown token or a lookup error → not_found.
  const client = await clientUnsubscribeStatus(token)
  const failed = searchParams?.error === '1'

  if (client.outcome === 'already') {
    return <Confirmation firstName={client.firstName} />
  }
  if (client.outcome === 'pending') {
    return <ClientStopForm token={token} firstName={client.firstName} failed={failed} />
  }

  // Not a client's link → it may be a referral partner's (partner emails,
  // slice 2). A PARTNER'S LINK ONLY LOOKS too: partnerUnsubscribeStatus is a
  // read (a database function Postgres itself holds read-only).
  const partner = await partnerUnsubscribeStatus(token)
  if (partner.outcome === 'already') {
    return <PartnerConfirmation firstName={partnerGreetingName(partner.partner) || null} />
  }
  if (partner.outcome === 'pending') {
    return <PartnerStopForm token={token} firstName={partnerGreetingName(partner.partner) || null} failed={failed} />
  }
  if (partner.outcome === 'failed') {
    return <Shell title="Something went wrong on our end" body={FAILED_BODY} />
  }

  // Unknown token → a clean state, NOT an error: the honest reading is "this
  // link doesn't do anything any more".
  return <Shell title="This link is no longer active" body={INACTIVE_BODY} />
}

const FAILED_BODY =
  "We couldn't process your unsubscribe just now. Please reply to any email from us with the word “unsubscribe” and a person will take you off the list — or try this link again in a few minutes."

const INACTIVE_BODY =
  "We couldn't find anything to do with this link. If you were trying to unsubscribe, reply to any email from us with the word “unsubscribe” and a person will take you off the list."

// The one confirmation surface — first click AND every click after it.
// Deliberately says nothing about which visit this is.
function Confirmation({ firstName }: { firstName: string | null }) {
  return (
    <Shell
      title={firstName ? `You're unsubscribed, ${firstName}` : "You're unsubscribed"}
      body="You won't get any more marketing emails from Bee Organized. If you change your mind, just reply to any email we've sent you and we'll happily add you back."
    />
  )
}

// ── A client's question (FL-75 slice 2) ──────────────────────────────────
// The same shape as the partner's: a plain HTML form (works with no
// JavaScript; a scanner that only opens links never sends it). The token
// travels in the address the form posts to, nowhere else.
function ClientStopForm({ token, firstName, failed }: { token: string; firstName: string | null; failed: boolean }) {
  return (
    <Shell
      title="Stop receiving marketing emails?"
      body={failed
        ? "We couldn't process that just now. Please press the button again, or reply to any email from us with the word “unsubscribe” and a person will take you off the list."
        : `${firstName ? `${firstName}, press` : 'Press'} the button below and Bee Organized will stop sending you marketing emails.`}
    >
      <StopButton token={token} />
    </Shell>
  )
}

function StopButton({ token }: { token: string }) {
  return (
    <form method="post" action={`/unsubscribe/${encodeURIComponent(token)}/confirm`} style={{ marginBottom: '20px' }}>
      <input type="hidden" name="confirm" value="yes" />
      <button
        type="submit"
        style={{ background: '#054E4A', color: 'white', border: 'none', borderRadius: '8px', padding: '12px 22px', fontSize: '15px', cursor: 'pointer' }}
      >
        Unsubscribe me
      </button>
    </form>
  )
}

// ── A referral partner's two states (partner emails, slice 2) ──────────────
// The question, with the one button that unsubscribes. A plain HTML form: it
// works with no JavaScript, and a scanner that only opens links never sends
// it. The token travels in the address the form posts to, nowhere else.
function PartnerStopForm({ token, firstName, failed }: { token: string; firstName: string | null; failed: boolean }) {
  return (
    <Shell
      title="Stop receiving these emails?"
      body={failed
        ? "We couldn't process that just now. Please press the button again, or reply to any email from us with the word “unsubscribe” and a person will take you off the list."
        : `${firstName ? `${firstName}, press` : 'Press'} the button below and Bee Organized will stop sending you these emails.`}
    >
      <StopButton token={token} />
    </Shell>
  )
}

// After the button. A partner's own unsubscribe is permanent, so — unlike the
// client page — it does not offer to add them back.
function PartnerConfirmation({ firstName }: { firstName: string | null }) {
  return (
    <Shell
      title={firstName ? `You're unsubscribed, ${firstName}` : "You're unsubscribed"}
      body="You won't get any more of these emails from Bee Organized."
    />
  )
}

// The opt-in page's Shell, verbatim: a branded, centered, single-card message.
// Duplicated rather than extracted so this build doesn't touch the live
// opt-in flow.
function Shell({
  title,
  body,
  children,
}: {
  title: string
  body: string
  // Only the two questions pass anything here (their button).
  children?: ReactNode
}) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f7f5f0',
        padding: '2rem',
        fontFamily: '"DM Sans", system-ui, sans-serif',
      }}
    >
      <div style={{ width: '100%', maxWidth: '420px', textAlign: 'center' }}>
        <div style={{ fontSize: '48px', marginBottom: '12px' }}>🐝</div>
        <h1
          style={{
            fontSize: '24px',
            fontFamily: 'Georgia, serif',
            color: '#1a2e2b',
            marginBottom: '12px',
          }}
        >
          {title}
        </h1>
        <p style={{ fontSize: '14px', color: '#4a5e5a', lineHeight: 1.6, marginBottom: '20px' }}>
          {body}
        </p>
        {children}
        <p style={{ fontSize: '12px', color: '#8a9e9a' }}>Bee Organized</p>
      </div>
    </div>
  )
}
