// app/access-removed/page.tsx
//
// Terminal notice shown to a hub_user whose access has been removed. The
// middleware (Layer 1) bounces every non-exempt route here while
// hub_users.disabled_at IS NOT NULL, so this page must NOT itself require an
// active membership — it only offers a way to read the notice and sign out.

export const metadata = {
  title: 'Access removed',
}

export default function AccessRemovedPage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        textAlign: 'center',
        padding: '4rem 1.25rem',
        fontFamily: '"DM Sans", system-ui, sans-serif',
        background: '#f7f5f0',
      }}
    >
      <div style={{ maxWidth: '460px' }}>
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>🔒</div>
        <h1
          style={{
            fontFamily: 'Georgia, serif',
            color: '#1a2e2b',
            fontSize: '24px',
            marginBottom: '12px',
          }}
        >
          Your access has been removed
        </h1>
        <p style={{ color: '#4a5e5a', fontSize: '14px', lineHeight: 1.6, marginBottom: '28px' }}>
          Your login for this location has been turned off. If you think this is
          a mistake, please contact your administrator.
        </p>
        <a
          href="/api/auth/signout"
          style={{
            display: 'inline-block',
            padding: '10px 20px',
            background: '#1a2e2b',
            color: 'white',
            borderRadius: '9px',
            fontSize: '13px',
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          Sign out
        </a>
      </div>
    </div>
  )
}
