// lib/emails-test-helpers.ts
//
// The Emails list folds (2026-10-30 design): only the first group starts
// open, and each shows three emails until "More" is pressed. Tests that need
// every row on screen open them the way an owner would — by clicking.

export async function expandAllEmailGroups(container: HTMLElement, act: (fn: () => Promise<void>) => Promise<void>) {
  for (let pass = 0; pass < 4; pass++) {
    const closed = Array.from(container.querySelectorAll('button[aria-expanded="false"]')) as HTMLButtonElement[]
    const more = (Array.from(container.querySelectorAll('button')) as HTMLButtonElement[])
      .filter(b => (b.textContent ?? '').startsWith('More —'))
    if (!closed.length && !more.length) return
    await act(async () => { for (const b of [...closed, ...more]) b.click() })
  }
}
