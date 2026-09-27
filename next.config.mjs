/** @type {import('next').NextConfig} */
const nextConfig = {
  // Email-signature headshots are served to mail clients from OUR domain
  // (beehive.beeorganized.com/email-signature-photos/<user>/<file>.jpg), not
  // the Supabase address — every image in a client email then comes from the
  // sending brand's own domain, like the drip logo. The public
  // email-signatures bucket sits behind it (migrations/email_signatures.sql,
  // lib/email-signature.ts). No auth: mail clients fetch with no session.
  async rewrites() {
    const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '')
    if (!supabaseUrl) return []
    return [
      {
        source: '/email-signature-photos/:path*',
        destination: `${supabaseUrl}/storage/v1/object/public/email-signatures/:path*`,
      },
    ]
  },
};

export default nextConfig;
