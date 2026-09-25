# Security model

What otp-guard protects you from, what it does not, and what it takes for granted. Read it before you rely on it.

## In short

otp-guard makes abusing your phone login **slow, visible and capped**. Every code needs a permit, every permit is limited, and the whole project has a spend ceiling. It does not make abuse impossible: someone with real phones, real numbers and many clean IP addresses looks exactly like your users.

## What it protects against

| Attack | How it is stopped |
|---|---|
| Calling Supabase directly, skipping your app | No permit, no code |
| Sending codes to expensive countries (SMS pumping) | Country allowlist, checked before an account exists |
| One IP address cycling through numbers | Per-origin limits, then an automatic block |
| One installation behind a rotating VPN | Device limits, and the unverified-numbers rule |
| Flooding one person's phone | Per-phone limits |
| One account sending to many numbers | Per-account number limit |
| Bursts of simultaneous requests | Database locks: limits hold exactly, even under load |
| Mass signups creating junk accounts | Signup limits in the Before User Created hook |
| Everything else failing | The project-wide spend ceiling |
| Bots in a browser | Cloudflare Turnstile on the web |
| Fake calls to your hooks | Signature check, with a 5-minute window |

## What it does not protect against

> [!WARNING]
> **Scripts pretending to be your mobile app.** The app tells the gateway which platform it is. A browser cannot pretend to be the mobile app, but a script can, and then it skips Turnstile and is held only by the rate limits. The real fix is platform attestation (App Attest, Play Integrity), which is not built yet. **If you have no native app, set `OTP_GUARD_MOBILE=off`.**

**Fake device IDs.** A client that invents a new device ID on every request makes the device rules useless. The IP, phone and project limits still apply. The device ID catches the common case, one real installation behind changing IPs, and nothing more.

**No captcha on signed-in requests.** `reauthenticate()` and MFA phone challenges skip Turnstile, because supabase-js sends no token for them. They only text the signed-in user's own number and still need a permit, so the risk is limited to someone with a valid session using up that account's quota.

**Large proxy networks with real numbers.** Many clean IP addresses, fresh device IDs and numbers that actually verify look like real users. The spend ceiling limits the damage; nothing here prevents it.

**Finding out which numbers are registered.** Different refusals return different messages, and Supabase's own responses can reveal whether a number has an account.

**Guessing codes.** Supabase checks codes and applies its own limits. otp-guard protects sending codes, not checking them.

**Delivery and conversion.** otp-guard does not know whether a message arrived or whether the user completed login. Few logins for many codes sent to one prefix is a strong pumping signal: watch for it in your provider's dashboard.

## What it takes for granted

These are true on Supabase today. `npm run verify` checks the ones that can be checked from outside.

1. **The gateway sees the caller's real IP address, and the caller cannot fake it.** Checked by `verify`. If this ever breaks, every IP-based limit can be bypassed.
2. **The Send SMS hook is not told the caller's IP address.** That is why the permit exists. If Supabase ever adds it, nothing breaks.
3. **Hook calls are signed** with the secret you configured, and Supabase only passes a hook's error on to your app when the hook answers HTTP 200 with the error in the body. Both hooks always do. Supabase re-runs a request when Auth answers with a 5xx, so otp-guard only uses 5xx where a rerun can help.
4. **Supabase stores each phone number once, without the `+`.** The unverified-numbers rule relies on it.

## Data it keeps

| What | Contains | Kept for |
|---|---|---|
| Permits and sends | Phone number, IP network, device ID | 24 hours |
| Numbers per device | Device ID, phone number | 90 days by default (`device.pending_lookback_days`) |
| Signup attempts | IP network, device ID | 24 hours |
| Risk events | IP, device ID, a hash of the number, the reason | 24 hours |
| Flagged subjects and reviews | IP or device, evidence counts, who reviewed | Until you delete them |

Codes are never stored or logged, and logs show only the last four digits of a phone number. Phone numbers and IP addresses are personal data in most countries, so check these periods against your privacy obligations.

Found a way around any of this? See [SECURITY.md](../SECURITY.md) to report it privately.
