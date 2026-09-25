# Architecture

## Request flow

```
Client (supabase-js + createOtpGuardFetch)
  │  POST /functions/v1/otp-gateway   { method, path, query, body }
  │  x-otp-guard-platform, x-otp-guard-device
  ▼
otp-gateway (Edge Function)
  │  1. platform and Origin rules
  │  2. Turnstile (web)
  │  3. otp_guard_create_permit(phone, ip, device, platform)
  │       blocks → destination → origin limits → device limits
  │       → pending verification → destination rotation
  │  4. forward to /auth/v1/<path> with the normalized phone
  ▼
Supabase Auth ──► Before User Created hook (new users only)
  │                 otp_guard_check_signup(ip, target) + extensions.ts
  │  generates the code
  ▼
Send SMS hook (Edge Function)
  │  1. verify Standard Webhooks signature
  │  2. otp_guard_authorize_send(phone, user_id)
  │       consume permit → blocks → destination → phone, account,
  │       device and global quotas → record send
  │  3. provider.send(phone, code)
  ▼
Provider (Bird)
```

### Routes

| Route | Phone comes from | Turnstile (web) |
|---|---|---|
| `POST /otp`, `POST /signup`, `POST /resend`, `PUT /user` | The request body. Guarded only when it has `phone` | Yes |
| `GET /reauthenticate` | The account, via `GET /auth/v1/user` with the caller's session. Only when the account has no email: Auth reauthenticates by email first | No |
| `POST /factors/{id}/challenge` | The MFA factor, via the same lookup. Only phone factors | No |

The last two text a number the signed-in user already verified, and supabase-js sends
no captcha token for them, so the gateway skips Turnstile there. They still need a
permit and count toward every limit. Without a valid session the gateway returns Auth's
own error and creates nothing. When no SMS is involved (email reauthentication, a TOTP
factor) the request is forwarded without a permit.

Auth still generates, stores and verifies the code. `verifyOtp` never touches
otp-guard: the protection is on issuing codes, which is where the money goes.

## Why a permit

The Send SMS hook is called by Auth server-to-server. Its payload is `{user, sms}`: it
has no client IP and no request headers. Limits applied only there can see the phone
and the account, but not who is asking.

The gateway sees the real client, so it decides there and records the decision as a
permit: phone, IP, /64 or host, device, platform, 60 seconds of validity. The hook then
consumes the permit for that phone. That gives the hook two things it could not have
otherwise:

1. **Attribution.** The IP and device of the request that caused this send, for quotas
   and risk scoring.
2. **A closed side door.** A direct call to `/auth/v1/otp` produces no permit, so the
   hook refuses it before the provider is contacted.

A permit is single use. It is consumed even when a quota then refuses the send, and a
permit revoked because the Auth call failed still counts toward the rate limits.

## Signup attribution

The Before User Created hook does receive an IP. But for signups started through the
gateway, that IP is the gateway's own, shared by all your users. So
`otp_guard_check_signup` looks for an active permit for the same phone and uses the
permit's IP and device instead. Email, OAuth and anonymous signups, which do not go
through the gateway, use the hook's IP.

## Storage

Everything lives in the `otp_guard` schema, which PostgREST does not expose. RLS is
enabled on every table with no policies, and the schema is revoked from API roles. The
six `public.otp_guard_*` functions are `SECURITY DEFINER` and only `service_role` can
execute them; the migration revokes Supabase's default grants to `anon` and
`authenticated`.

Phones are stored in clear only where a rule needs to compare them (`permits`, `sends`,
`device_phones`) and for at most 24 hours, except `device_phones`, which is kept for
`device.pending_lookback_days`. Risk events store a SHA-256 of the target. Codes are
never stored or logged.

## Concurrency

Two advisory locks:

- `otp_guard:permits` serializes permit creation, so concurrent gateway calls from one
  origin cannot all pass the same limit.
- `otp_guard:risk` serializes send authorization, signup checks, risk scoring and
  releases, so the global ceiling is exact.

The order is always permits → risk, so no path deadlocks. Both are transaction locks
held for a few milliseconds; the provider call happens after the transaction commits.
This is a global serialization point: it is fine for thousands of sends per hour, and
it is the first thing to revisit if you need much more.

## Failure modes

Every path fails closed:

| Failure | Result |
|---|---|
| Postgres unreachable, timeout (2.5 s), malformed decision | 503, provider not contacted |
| A setting missing from `otp_guard.settings` | The function raises, 503 |
| `allowed_destinations` empty | Every phone refused |
| Hook secret missing or signature invalid | 503 / 401 |
| Turnstile secret missing or siteverify down | Web refused, 503 |
| Provider error | 503, quota stays consumed |

The last row is on purpose: if a provider error refunded the quota, retrying provider
errors would let an attacker send without limit.
