// components/hive/shared/currentUserContext.js
// Auth context — populated by App({ currentUser }) in BeeHub.jsx (page.tsx →
// BeeHubApp). Components deep in the tree (JobberConnectStep,
// ImportStepContent, the extracted AdminFeedbackScreen) read the signed-in
// user from here instead of being prop-drilled.
// Value shape: { id, email, name, role, locationId } or null.
//
// Lives here (not in BeeHub.jsx) so extracted modules can import it without
// a circular BeeHub dependency. BeeHub.jsx re-exports it, so existing
// `import { CurrentUserContext } from '@/components/BeeHub'` sites still work.
// PURE module (react only) — safe in any bundle.
'use client'

import { createContext } from 'react'

export const CurrentUserContext = createContext(null)
