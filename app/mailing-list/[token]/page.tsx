// app/mailing-list/[token]/page.tsx
//
// The public opt-in landing page — where the "we're not in your area yet"
// email's link lands. Mirrors the invite accept page (app/auth/invite/[token]):
// a server component looks the token up through the SERVICE role and branches
// on state. The click is anonymous — there is no session to scope by — so the
// service client is the only way to read the row, and it reads by token alone.
//
// PII: the URL carries the token and NOTHING else. No lead id, no email, no
// name. This link will sit in an inbox, a browser history and quite possibly a
// forwarded message forever; the token is the only thing it may leak, and the
// token's only power is "add this person to a mailing list they were offered".
//
// IDEMPOTENT, NOT ONE-TIME. This is the deliberate difference from the invite
// page, which shows "Already accepted" on a second visit. Here a second click
// is not a mistake to report — people re-click links, mail clients pre-fetch
// them, phones open them twice. The FIRST consume records consent; every later
// visit re-renders the same confirmation. There is no state in which a person
// who joined the list is told something went wrong.
//
// NOT under /api: this is a human-facing page a person reads, so it lives at a
// human-facing route. middleware.ts needs no change for it — the middleware
// only enforces the disabled-hub_user lockout, and an anonymous visitor passes
// straight through.
//
// The lead is ALREADY dismissed from the routing queue at send time (Kevin's
// rule, see the no-coverage endpoint). This page does not touch
// inbox_dismissed_at.

import { supabaseService } from '@/lib/supabase-service'
import { NO_COVERAGE_CONSENT_SOURCE } from '@/lib/no-coverage-email'

export const runtime = 'nodejs'
// Never statically render or cache: this renders a per-token state AND (on the
// first visit) performs the consent write.
export const dynamic = 'force-dynamic'

type Props = { params: { token: string } }

// Any lookup failure — unknown token, or the columns not existing yet because
// migrations/no_coverage_optin.sql is still held — resolves to "no row", which
// renders the clean inactive-link state. A visitor must never meet a stack
// trace or a 500 on a link WE sent them.
async function findByToken(token: string) {
  try {
    const { data, error } = await supabaseService
      .from('leads')
      .select('id, first_name, name, optin_token_expires_at, marketing_consented_at')
      .eq('optin_token', token)
      .maybeSingle()
    if (error) {
      console.warn('[mailing-list] token lookup failed', error.message)
      return null
    }
    return data
  } catch (err) {
    console.warn('[mailing-list] token lookup threw', err)
    return null
  }
}

export default async function MailingListOptInPage({ params }: Props) {
  const token = params?.token || ''

  if (!token) {
    return <Shell title="This link is no longer active" body={INACTIVE_BODY} />
  }

  const lead = await findByToken(token)

  // Unknown token. A clean state, NOT an error: the honest reading is "this
  // link doesn't do anything any more", and there is nothing the visitor could
  // have done wrong.
  if (!lead) {
    return <Shell title="This link is no longer active" body={INACTIVE_BODY} />
  }

  const alreadyConsented = !!lead.marketing_consented_at

  // Already on the list → confirmation, whatever the expiry says. Expiry bounds
  // the creation of NEW consent records; it must never retract one that exists,
  // or a re-click months later would tell a subscriber they aren't subscribed.
  if (alreadyConsented) {
    return <Confirmation firstName={firstOf(lead)} />
  }

  const expiresAt = lead.optin_token_expires_at
    ? new Date(lead.optin_token_expires_at).getTime()
    : 0
  if (!expiresAt || expiresAt < Date.now()) {
    return (
      <Shell
        title="This link has expired"
        body="Links in our emails stay active for about six weeks. If you'd still like to hear from us when we reach your area, reply to the email we sent you and we'll take care of it."
      />
    )
  }

  // ─── FIRST CONSUME — record the consent ───────────────────────
  // WHEN (marketing_consented_at) and HOW (marketing_consent_source), which is
  // the pair the compliance question actually turns on. The .is(...) filter
  // makes the write first-consume-wins at the DATABASE, so two clicks racing
  // each other can't produce two consent events with two different timestamps.
  //
  // A write failure still renders the confirmation. The person did the thing
  // they were asked to do; blaming them for our database is the wrong trade,
  // and the warn is how we find out. It does mean an unrecorded consent must
  // be treated as no consent by anything that later sends to this list — which
  // is correct: the record IS the permission.
  const { error: consentError } = await supabaseService
    .from('leads')
    .update({
      marketing_consented_at: new Date().toISOString(),
      marketing_consent_source: NO_COVERAGE_CONSENT_SOURCE,
      updated_at: new Date().toISOString(),
    })
    .eq('id', lead.id)
    .is('marketing_consented_at', null)
  if (consentError) {
    console.warn('[mailing-list] consent write failed', consentError.message)
  } else {
    // Provenance in the person's own timeline too, so the record is legible
    // where a human looks rather than only in a column.
    try {
      await supabaseService.from('touchpoints').insert({
        lead_id:     lead.id,
        kind:        'system',
        method:      'system',
        label:       'Joined the mailing list',
        notes:       'Clicked the opt-in link in the "not in your area yet" email.',
        status:      'done',
        occurred_at: new Date().toISOString(),
      })
    } catch (err) {
      console.warn('[mailing-list] consent touchpoint failed', err)
    }
  }

  return <Confirmation firstName={firstOf(lead)} />
}

function firstOf(lead: { first_name?: string | null; name?: string | null }): string | null {
  const explicit = (lead.first_name || '').trim()
  if (explicit) return explicit.split(/\s+/)[0]
  const full = (lead.name || '').trim()
  if (full) return full.split(/\s+/)[0]
  return null
}

const INACTIVE_BODY =
  "We couldn't find anything to do with this link. If you were trying to join our mailing list, reply to the email we sent you and we'll add you."

// The one confirmation surface — shown on the first click AND on every click
// after it. Deliberately says nothing about which visit this is.
function Confirmation({ firstName }: { firstName: string | null }) {
  return (
    <Shell
      title={firstName ? `You're on the list, ${firstName}` : "You're on the list"}
      body="We'll email you when Bee Organized opens a location near you. That's the only reason we'll be in touch — and you can tell us to stop at any time by replying to any email from us."
    />
  )
}

// The invite page's Shell, verbatim in spirit: a branded, centered, single-card
// message. This is the one place in the app a stranger sees, so it looks like
// the brand and says one thing.
function Shell({
  title,
  body,
}: {
  title: string
  body: string
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
        <p style={{ fontSize: '12px', color: '#8a9e9a' }}>Bee Organized</p>
      </div>
    </div>
  )
}
