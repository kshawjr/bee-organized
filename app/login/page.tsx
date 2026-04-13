'use client'

import { useState } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import { useRouter } from 'next/navigation'
import './login.css'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setError(error.message)
      setLoading(false)
    } else {
      router.push('/dashboard')
    }
  }

  return (
    <div className="login-root">
      <div className="login-left">
        <div className="hex-bg" />
        <svg className="hex-accent hex-accent-1" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
          <polygon points="50,5 95,27 95,73 50,95 5,73 5,27" fill="#a8c9c4" />
        </svg>
        <svg className="hex-accent hex-accent-2" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
          <polygon points="50,5 95,27 95,73 50,95 5,73 5,27" fill="#d4a046" />
        </svg>
        <div className="login-left-content">
          <span className="bee-icon">🐝</span>
          <div className="brand-name">Bee Organized</div>
          <div className="brand-sub">Operations Hub</div>
          <div className="divider-line" />
          <div className="brand-tagline">
            Simplifying your franchise, one hive at a time.
          </div>
        </div>
      </div>

      <div className="login-right">
        <div className="login-form-wrap">
          <div className="form-greeting">Welcome back.</div>
          <div className="form-sub">Sign in to your operations hub</div>

          {error && <div className="error-msg">{error}</div>}

          <form onSubmit={handleLogin}>
            <label className="form-label">Email</label>
            <input
              className="form-input"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@beeorganized.com"
              required
            />

            <label className="form-label">Password</label>
            <input
              className="form-input"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />

            <div>
              <button className="form-button" type="submit" disabled={loading}>
                {loading ? 'Signing in...' : 'Sign In'}
              </button>
              <div className="gold-bar" />
            </div>
          </form>

          <div className="footer-note">
            Bee Organized · Franchise Operations Hub
          </div>
        </div>
      </div>
    </div>
  )
}