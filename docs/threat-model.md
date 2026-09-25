# Threat model

## Covered

| Attack | Defense |
|---|---|
| Direct calls to `/auth/v1/otp` bypassing your app | No permit, no send |
| SMS pumping to premium destinations | Destination allowlist, before an account exists |
| Rotating destinations from one IP | `origin.phones_*`, then risk block |
| Rotating IPs (VPN) from one installation | Device limits and `device.pending_phones` |
| Flooding one victim's phone | `phone.*` limits |
| One account fanning out to many numbers | `account.phones_per_day` |
| Bursts of concurrent requests | Advisory locks: limits are exact |
| Mass signups creating junk accounts | `signup.*` limits in the Before User Created hook |
| Everything else failing | `global.*` spend ceiling |
| Browser automation from web | Turnstile |
| Forged hook calls | Standard Webhooks signature with 5-minute tolerance |

## Not covered

**Scripts posing as your mobile app.** The platform header is set by the client. A
browser cannot fake `mobile`, because it always sends `Origin` on this request, but a
script can. Such requests skip Turnstile and are held only by the rate limits.
Platform attestation (App Attest, Play Integrity) is the fix and is not implemented
yet. If you have no native app, set `OTP_GUARD_MOBILE=off`.

**Captcha on session routes.** `reauthenticate()` and MFA phone challenges skip
Turnstile, because supabase-js sends no token for them. They only text the signed-in
user's own number and are bound by the permit limits, so the exposure is an attacker
with a valid session spending that account's phone and account quotas.

**Forged device IDs.** A client that sends a fresh UUID with every request makes
device rules useless. Origin, phone and global limits still apply. The device ID
catches the common case, a real installation behind changing IPs, and nothing more.

**Large residential proxy pools with real numbers.** An attacker with many clean IPs,
fresh device IDs and numbers that do verify looks like real users. The global ceiling
limits the damage; nothing here prevents it.

**Phone number enumeration.** Rejection messages differ by reason, and Auth's own
responses can reveal whether a number is registered.

**Verification brute force.** Auth verifies codes and applies its own limits. otp-guard
protects issuing codes, not checking them.

**Delivery analytics.** otp-guard does not know whether a message arrived or whether
the user verified, except through `auth.users.phone_confirmed_at` for the pending rule.
Low conversion by prefix is a strong pumping signal; watch it in your provider.

## Assumptions

These hold on Supabase today. `scripts/verify.mjs` checks the ones that can be checked
from outside.

1. **The gateway sees the real client IP in the first `X-Forwarded-For` entry**, and a
   client cannot inject its own. Checked by `verify.mjs`. If this breaks, every
   IP-based limit is bypassable.
2. **The Send SMS hook payload has no client IP.** Hence the permit. If Auth ever adds
   one, nothing breaks.
3. **Auth hooks are signed** with the secret you configured. Auth relays a hook error to
   the client only when it arrives as HTTP 200 with `{"error": {"http_code", "message"}}`;
   a 4xx becomes a generic 500 and a 429/503 is retried. Both hooks always answer 200, so
   refusals reach the user and are never retried.
4. **`auth.users.phone` is unique and stored without `+`**, used by the pending rule.

## Data kept

| Table | Contents | Retention |
|---|---|---|
| `permits`, `sends` | Phone, IP network, device ID | 24 h (`retention.hours`) |
| `device_phones` | Device ID, phone | `device.pending_lookback_days` |
| `signup_attempts` | IP network, device ID | 24 h |
| `risk_events` | IP, device ID, SHA-256 of target, reason | 24 h |
| `risk_subjects`, `risk_reviews` | IP or device, evidence counts, reviewer | Until you delete them |

Codes are never stored or logged. Logs mask phones to their last four digits. Check
the retention against your privacy obligations; phones and IPs are personal data in
most jurisdictions.
