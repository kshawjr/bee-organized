// lib/email-escape.ts
//
// The ONE escaping implementation for hand-built client email HTML. Lives on
// its own so lib/drip-email-layout.ts and lib/email-signature.ts can both use
// it without importing each other. drip-email-layout re-exports both, so every
// existing `import { escHtml } from './drip-email-layout'` is unchanged.

// Exported so sibling email builders (lib/feedback-reply-email) escape through
// the SAME implementation rather than re-rolling one each — issue 233. Escaping
// duplicated is escaping that drifts.
export function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// URL for an href attribute: escape only the chars that could break out of the
// quoted attribute. Ampersands in query strings become &amp; so the HTML is
// well-formed; the browser/mail client decodes them back on click.
export function escAttr(url: string): string {
  return url
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
