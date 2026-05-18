'use client'

// Client-side accept flow.
//   - Not signed in: render Google sign-in button. redirectTo loops back to
//     this same /auth/invite/[token] page so we land here with a session
//     and the autoAccept effect below fires the POST.
//   - Signed in: POST /api/hub_users/accept; redirect home on success.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'

type Props = {
  token: string
  inviteEmail: string
  fullName: string | null
  locationName: string | null
  authedEmail: string | null
}

export default function AcceptInviteClient({
  token,
  inviteEmail,
  fullName,
  locationName,
  authedEmail,
}: Props) {
  const router = useRouter()
  const supabase = createClient()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [step, setStep] = useState<'idle' | 'accepting' | 'done'>('idle')

  const emailsMatch =
    !!authedEmail &&
    authedEmail.trim().toLowerCase() === inviteEmail.trim().toLowerCase()

  async function googleSignIn() {
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(`/auth/invite/${token}`)}`,
        queryParams: { login_hint: inviteEmail },
      },
    })
    if (error) {
      setError(error.message)
      setLoading(false)
    }
  }

  async function acceptInvite() {
    setStep('accepting')
    setError('')
    const res = await fetch('/api/hub_users/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invite_token: token }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(json.error || 'Could not accept invitation')
      setStep('idle')
      return
    }
    setStep('done')
    // Flag a fresh accept so DashboardScreen knows to render the lightweight
    // employee onboarding once. Cleared when they finish or skip.
    try { sessionStorage.setItem('bee.employeeOnboarding', '1') } catch {}
    router.push('/')
  }

  useEffect(() => {
    // If the invitee returned from Google with a session AND the email matches,
    // auto-accept. They can still hit the button manually if this effect races.
    if (authedEmail && emailsMatch && step === 'idle') {
      acceptInvite()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authedEmail])

  const greeting = fullName ? fullName.split(' ')[0] : 'there'

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
      <div style={{ width: '100%', maxWidth: '420px' }}>
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <div style={{ fontSize: '48px', marginBottom: '12px' }}>🐝</div>
          <h1
            style={{
              fontSize: '26px',
              fontFamily: 'Georgia, serif',
              color: '#1a2e2b',
              marginBottom: '8px',
            }}
          >
            Welcome, {greeting}!
          </h1>
          <p style={{ fontSize: '14px', color: '#4a5e5a', lineHeight: 1.6 }}>
            You&apos;ve been invited to join{' '}
            <strong>{locationName || 'a Bee Organized location'}</strong> on Bee Hub.
          </p>
        </div>

        <div
          style={{
            background: 'white',
            border: '1px solid rgba(0,0,0,0.06)',
            borderRadius: '16px',
            padding: '24px 22px',
            boxShadow: '0 4px 20px rgba(26,46,43,0.04)',
            textAlign: 'center',
          }}
        >
          {!authedEmail && (
            <>
              <p style={{ fontSize: '13px', color: '#4a5e5a', marginBottom: '6px' }}>
                Sign in with the Google account for
              </p>
              <p
                style={{
                  fontSize: '15px',
                  fontWeight: 600,
                  color: '#1a2e2b',
                  marginBottom: '18px',
                  wordBreak: 'break-all',
                }}
              >
                {inviteEmail}
              </p>
              <button
                onClick={googleSignIn}
                disabled={loading}
                style={{
                  width: '100%',
                  padding: '12px',
                  background: 'white',
                  color: '#1a2e2b',
                  border: '1.5px solid rgba(0,0,0,0.1)',
                  borderRadius: '10px',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: loading ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '10px',
                  opacity: loading ? 0.6 : 1,
                }}
              >
                <svg width="18" height="18" viewBox="0 0 18 18">
                  <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" />
                  <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" />
                  <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
                  <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
                </svg>
                {loading ? 'Redirecting…' : 'Continue with Google'}
              </button>
            </>
          )}

          {authedEmail && !emailsMatch && (
            <>
              <p style={{ fontSize: '13px', color: '#ef4444', marginBottom: '12px', lineHeight: 1.5 }}>
                You&apos;re signed in as <strong>{authedEmail}</strong>, but this invitation was for{' '}
                <strong>{inviteEmail}</strong>.
              </p>
              <p style={{ fontSize: '12px', color: '#8a9e9a', marginBottom: '16px', lineHeight: 1.5 }}>
                Sign out and sign back in with the invited account.
              </p>
              <a
                href="/api/auth/signout"
                style={{
                  display: 'inline-block',
                  padding: '10px 18px',
                  background: '#1a2e2b',
                  color: 'white',
                  borderRadius: '10px',
                  fontSize: '13px',
                  fontWeight: 600,
                  textDecoration: 'none',
                }}
              >
                Sign out
              </a>
            </>
          )}

          {authedEmail && emailsMatch && step === 'accepting' && (
            <p style={{ fontSize: '14px', color: '#4a5e5a' }}>Activating your account…</p>
          )}

          {authedEmail && emailsMatch && step === 'done' && (
            <p style={{ fontSize: '14px', color: '#22c55e' }}>You&apos;re in — taking you to your hub…</p>
          )}

          {authedEmail && emailsMatch && step === 'idle' && (
            <>
              <p style={{ fontSize: '13px', color: '#4a5e5a', marginBottom: '14px' }}>
                Ready to accept this invitation?
              </p>
              <button
                onClick={acceptInvite}
                style={{
                  padding: '11px 22px',
                  background: '#1a2e2b',
                  border: 'none',
                  borderRadius: '10px',
                  fontSize: '13px',
                  fontWeight: 600,
                  color: 'white',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Accept invitation →
              </button>
            </>
          )}

          {error && (
            <p
              style={{
                color: '#ef4444',
                fontSize: '12px',
                marginTop: '14px',
                padding: '8px 12px',
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.15)',
                borderRadius: '8px',
                textAlign: 'left',
              }}
            >
              {error}
            </p>
          )}
        </div>

        <p
          style={{
            textAlign: 'center',
            fontSize: '11px',
            color: '#b0c0bc',
            marginTop: '1.5rem',
            letterSpacing: '0.05em',
          }}
        >
          Bee Organized · Franchise Operations Hub
        </p>
      </div>
    </div>
  )
}
