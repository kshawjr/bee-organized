'use client'

import { Suspense, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'

function LoginForm() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const supabase = createClient()
  const searchParams = useSearchParams()
  const errorParam = searchParams.get('error')

  async function handleGoogleLogin() {
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    })
    if (error) {
      setError(error.message)
      setLoading(false)
    }
    // On success, the browser redirects to Google. No further action needed.
  }

  return (
    <div style={{ width: '100%', maxWidth: '380px' }}>
      {/* Brand header */}
      <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
        <div
          style={{
            width: '56px',
            height: '56px',
            background: '#1a2e2b',
            borderRadius: '14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 1rem',
            fontSize: '28px',
          }}
        >
          🐝
        </div>
        <h1
          style={{
            fontSize: '32px',
            fontFamily: '"Playfair Display", Georgia, serif',
            color: '#1a2e2b',
            fontWeight: 500,
            letterSpacing: '-0.5px',
          }}
        >
          Bee Hub
        </h1>
        <p
          style={{
            color: '#8a9e9a',
            fontSize: '11px',
            marginTop: '4px',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
          }}
        >
          Franchise Operations
        </p>
      </div>

      {/* Card */}
      <div
        style={{
          background: 'white',
          border: '1px solid rgba(0,0,0,0.06)',
          borderRadius: '16px',
          padding: '2rem 1.75rem',
          boxShadow: '0 4px 20px rgba(26,46,43,0.04)',
          textAlign: 'center',
        }}
      >
        <h2
          style={{
            fontSize: '17px',
            fontWeight: 600,
            color: '#1a2e2b',
            marginBottom: '6px',
          }}
        >
          Sign in to continue
        </h2>
        <p style={{ fontSize: '13px', color: '#8a9e9a', marginBottom: '1.5rem' }}>
          Use your Bee Organized Google account
        </p>

        <button
          onClick={handleGoogleLogin}
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
            transition: 'border-color 0.15s',
          }}
          onMouseEnter={(e) => {
            if (!loading)
              (e.currentTarget as HTMLButtonElement).style.borderColor =
                '#1a2e2b'
          }}
          onMouseLeave={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.borderColor =
              'rgba(0,0,0,0.1)'
          }}
        >
          <svg width="18" height="18" viewBox="0 0 18 18">
            <path
              fill="#4285F4"
              d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
            />
            <path
              fill="#34A853"
              d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z"
            />
            <path
              fill="#FBBC05"
              d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
            />
            <path
              fill="#EA4335"
              d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
            />
          </svg>
          {loading ? 'Redirecting…' : 'Continue with Google'}
        </button>

        {(error || errorParam) && (
          <p
            style={{
              color: '#ef4444',
              fontSize: '12px',
              marginTop: '1rem',
              padding: '8px 12px',
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.15)',
              borderRadius: '8px',
              textAlign: 'left',
            }}
          >
            {error || 'Could not sign you in. Please try again.'}
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
  )
}

export default function LoginPage() {
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
      <Suspense fallback={<div style={{ color: '#8a9e9a', fontSize: '13px' }}>Loading…</div>}>
        <LoginForm />
      </Suspense>
    </div>
  )
}
