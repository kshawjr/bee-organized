// components/hive/shared/useIsMobile.js — THE beta mobile detection,
// extracted from the six per-component copies (BeeHub.jsx:5042 pattern):
// width 0 on SSR and first client render so both sides agree and
// hydration is clean; flips to the real width after mount.
//
// Tests: renderToString never runs effects, so the width would stay 0
// and the mobile branches would be untestable — a test may seed
// globalThis.__BEE_TEST_WIDTH__ before rendering to exercise them
// (see lib/beta-mobile-layout.test.tsx). Unset in prod → behavior
// identical to the old inline blocks.
'use client'

import { useState, useEffect } from 'react'

export default function useIsMobile() {
  const [windowWidth, setWindowWidth] = useState(() => (
    typeof globalThis.__BEE_TEST_WIDTH__ === 'number' ? globalThis.__BEE_TEST_WIDTH__ : 0
  ))
  useEffect(() => {
    const check = () => setWindowWidth(window.innerWidth)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])
  return windowWidth > 0 && windowWidth < 768
}
