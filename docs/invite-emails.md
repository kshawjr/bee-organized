# Invite emails

Owner, manager, lite-user, and corporate-admin invitations are sent via a
**system sender** rather than the per-location sender used by drip emails.

## Why

A franchise location's `send_from_email` / `sender_name` /
`reply_to_email` are populated during the owner's onboarding. But the
owner invitation goes out *before* onboarding — there's no owner yet —
so those fields are NULL and the per-location sender path (`sendEmail()`
in `lib/resend.ts`) can't be used. Corporate-admin invites have no
location at all, so they hit the same wall.

`app/api/hub_users/invite/route.ts` therefore calls `sendEmailDirect()`
with a fixed system sender.

## Defaults

| Env var                  | Default                   |
| ------------------------ | ------------------------- |
| `INVITE_FROM_EMAIL`      | `admin@beeorganized.com`  |
| `INVITE_FROM_NAME`       | `Kevin Shaw`              |
| `INVITE_REPLY_TO_EMAIL`  | `admin@beeorganized.com`  |

The defaults are baked into the route so the system works out of the box
without env vars set. Override any of them via env if the sender ever
changes.

`admin@beeorganized.com` is the same sender used for drip emails and is
already verified in Resend. If you change `INVITE_FROM_EMAIL`, the new
domain must be Resend-verified or sends will fail.
