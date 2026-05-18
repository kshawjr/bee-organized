// app/auth/invite/[token]/page.tsx
//
// Accept-invite landing page. Server component looks up the pending_invites
// row by token, branches on state (not found / expired / consumed / valid),
// and renders the right surface. The valid path renders a client-side
// Google sign-in button; after auth, AcceptClient posts the token to
// /api/hub_users/accept which creates the hub_users row and claims a seat.

import { supabaseService } from '@/lib/supabase-service'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import AcceptInviteClient from './AcceptInviteClient'

export const runtime = 'nodejs'

type Props = { params: { token: string } }

async function getLocationName(locationId: string): Promise<string | null> {
  const { data } = await supabaseService
    .from('locations')
    .select('name')
    .eq('id', locationId)
    .single()
  return data?.name || null
}

export default async function InviteAcceptPage({ params }: Props) {
  const { token } = params

  const { data: invite } = await supabaseService
    .from('pending_invites')
    .select(
      'id, email, full_name, role, tier, location_id, invite_token, invite_expires_at, accepted_at'
    )
    .eq('invite_token', token)
    .single()

  // Is the user already signed in? If so we may be able to auto-accept.
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!invite) {
    return <Shell title="Invitation not found" body="This link is no longer valid. Ask whoever invited you to send a fresh link." />
  }
  if (invite.accepted_at) {
    return <Shell title="Already accepted" body="This invitation has already been used. Sign in normally to access your location." cta={{ href: '/auth/login', label: 'Go to sign in' }} />
  }
  if (new Date(invite.invite_expires_at).getTime() < Date.now()) {
    return <Shell title="Invitation expired" body="This invite link has expired. Ask the location owner to resend it." />
  }

  const locationName = await getLocationName(invite.location_id)

  return (
    <AcceptInviteClient
      token={token}
      inviteEmail={invite.email}
      fullName={invite.full_name}
      locationName={locationName}
      authedEmail={user?.email || null}
    />
  )
}

function Shell({
  title,
  body,
  cta,
}: {
  title: string
  body: string
  cta?: { href: string; label: string }
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
        {cta && (
          <a
            href={cta.href}
            style={{
              display: 'inline-block',
              padding: '11px 22px',
              background: '#1a2e2b',
              color: 'white',
              borderRadius: '10px',
              fontSize: '13px',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            {cta.label}
          </a>
        )}
      </div>
    </div>
  )
}
