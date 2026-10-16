// components/hive/shared/tagText.js
// ─────────────────────────────────────────────────────────────
// How a tag reads on screen: its own icon (lookups.icon) then its label —
// "🏠 Realtor". The emoji lives in the icon field, never in the label
// (search, sorting and Mailchimp all use the bare label). A tag with no
// icon (DO NOT BOOK, Lead, Partner) shows its label alone.
//
// Before the tag merge BeeHub glued the icon onto the label when it loaded
// the specialty list; the merged screens read the bare label, so this is
// the one place the two are joined again. PURE, zero imports.
// ─────────────────────────────────────────────────────────────

export function tagText(tag) {
  if (!tag) return ''
  const icon = typeof tag.icon === 'string' ? tag.icon.trim() : ''
  return icon ? `${icon} ${tag.label || ''}` : (tag.label || '')
}
