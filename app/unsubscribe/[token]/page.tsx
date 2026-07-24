// app/unsubscribe/[token]/page.tsx
//
// The public unsubscribe landing page — where a marketing email's footer link
// lands. Mirrors the opt-in page (app/mailing-list/[token]) beat for beat: a
// server component looks the token up through the SERVICE role (the click is
// anonymous — there is no session to scope by) and branches on state. The URL
// carries the token and NOTHING else — no lead id, no email, no PII.
//
// IDEMPOTENT, NOT ONE-TIME, like the opt-in page: people re-click links, mail
// clients pre-fetch them. The FIRST consume records the withdrawal; every
// later visit re-renders the same confirmation. A person who unsubscribed is
// never told something went wrong.
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

import { supabaseService } from '@/lib/supabase-service'
import { applyDripSideEffects } from '@/lib/drip-lifecycle'

export const runtime = 'nodejs'
// Never statically render or cache: per-token state + (on the first visit)
// the withdrawal write.
export const dynamic = 'force-dynamic'

type Props = { params: { token: string } }

// Any lookup failure — unknown token, or the columns not existing yet because
// migrations/marketing_unsubscribe.sql is still held — resolves to "no row",
// which renders the clean inactive-link state. A visitor must never meet a
// stack trace or a 500 on a link WE sent them.
async function findByToken(token: string) {
  try {
    const { data, error } = await supabaseService
      .from('leads')
      .select('id, first_name, name, location_uuid, marketing_unsubscribed_at, marketing_opt_out')
      .eq('unsubscribe_token', token)
      .maybeSingle()
    if (error) {
      console.warn('[unsubscribe] token lookup failed', error.message)
      return null
    }
    return data
  } catch (err) {
    console.warn('[unsubscribe] token lookup threw', err)
    return null
  }
}

export default async function UnsubscribePage({ params }: Props) {
  const token = params?.token || ''

  if (!token) {
    return <Shell title="This link is no longer active" body={INACTIVE_BODY} />
  }

  const lead = await findByToken(token)

  // Unknown token → a clean state, NOT an error: the honest reading is "this
  // link doesn't do anything any more".
  if (!lead) {
    return <Shell title="This link is no longer active" body={INACTIVE_BODY} />
  }

  // Already withdrawn → confirmation, no write. marketing_unsubscribed_at is
  // the idempotency flag (only this page stamps it); a staff-set
  // marketing_opt_out without it still proceeds to the write below so the
  // person's OWN act gets its own timestamped record.
  if (lead.marketing_unsubscribed_at) {
    return <Confirmation firstName={firstOf(lead)} />
  }

  // ─── FIRST CONSUME — record the withdrawal ────────────────────
  // Both columns, one write: marketing_opt_out is the DO-NOT-SEND flag every
  // send rail already honors (drip-send, stage-emails, welcome-email);
  // marketing_unsubscribed_at is WHEN the person withdrew — the counterpart of
  // marketing_consented_at, which is deliberately NOT cleared: it remains the
  // record that sends made before this moment were permitted. The .is(...)
  // filter makes the write first-consume-wins at the DATABASE, so two clicks
  // racing each other can't produce two withdrawal events.
  const now = new Date().toISOString()
  const { error: withdrawError } = await supabaseService
    .from('leads')
    .update({
      marketing_opt_out: true,
      marketing_unsubscribed_at: now,
      updated_at: now,
    })
    .eq('id', lead.id)
    .is('marketing_unsubscribed_at', null)

  if (withdrawError) {
    // The inverted failure posture — see the header. Never a false "you're
    // unsubscribed"; an honest state with a human fallback instead.
    console.error('[unsubscribe] withdrawal write failed', withdrawError.message)
    return (
      <Shell
        title="Something went wrong on our end"
        body="We couldn't process your unsubscribe just now. Please reply to any email from us with the word “unsubscribe” and a person will take you off the list — or try this link again in a few minutes."
      />
    )
  }

  // The same immediate-silence cascade a staff-set opt-out gets (stop active
  // drips, cancel pending stage + welcome emails). Belt-and-braces — every
  // send rail re-checks marketing_opt_out at send time — so a failure here is
  // warned, never shown: the flag is already down, and that alone stops
  // every send.
  try {
    await applyDripSideEffects({
      leadId: lead.id,
      locationUuid: lead.location_uuid || '',
      prevStage: null,
      patch: { marketing_opt_out: true },
    })
  } catch (err) {
    console.warn('[unsubscribe] opt-out cascade failed', err)
  }

  // Provenance in the person's own timeline, so the withdrawal is legible
  // where a human looks rather than only in a column. Non-fatal.
  try {
    await supabaseService.from('touchpoints').insert({
      lead_id:     lead.id,
      kind:        'system',
      method:      'system',
      label:       'Unsubscribed from marketing emails',
      notes:       'Clicked the unsubscribe link in a marketing email. Marketing opt-out set; consent history retained.',
      status:      'done',
      occurred_at: now,
    })
  } catch (err) {
    console.warn('[unsubscribe] withdrawal touchpoint failed', err)
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

// The opt-in page's Shell, verbatim: a branded, centered, single-card message.
// Duplicated rather than extracted so this build doesn't touch the live
// opt-in flow.
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
