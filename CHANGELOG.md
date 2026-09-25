# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). While the version is `0.x`, a minor release (`0.2.0`) may require steps when upgrading; they are always listed under **Upgrading**.

## [Unreleased]

## [0.1.0] - 2026-09-25

First public pre-release.

### Added

- One-time send permits: the `otp-gateway` Edge Function issues them, and the Send SMS hook refuses to deliver without one.
- Rate limits per phone, account, device and origin (IPv4 host or IPv6 /64), with detection of one origin or device cycling through numbers.
- Unverified-numbers rule: a device that received codes for two numbers that never verified cannot request a third. Numbers that already belong to a verified account are exempt.
- Country allowlist and prefix blocklist, checked before Supabase creates an account.
- Project-wide spend ceiling per minute, hour and day, with a `near_limit` warning.
- Risk events and automatic blocking of IPs and devices, with an audited manual release (`otp_guard_release`).
- Signup limits in the Before User Created hook, with `extensions.ts` for your own rules. Gateway signups are attributed to the client's IP through the permit.
- Cloudflare Turnstile for web requests, verified by the gateway.
- Support for `signInWithOtp`, `signUp`, `resend`, phone changes, `reauthenticate()` and MFA phone challenges.
- Presets: `strict`, `balanced` and `high-volume`.
- Bird provider for SMS and WhatsApp, behind the `OtpProvider` interface.
- `@otp-guard/client`: a `fetch` for supabase-js that routes phone OTP requests through the gateway, plus device ID helpers.
- Scripts: `npm run verify`, `npm run demo:attack` and `npm run e2e:mobile`.
- Documentation: Quickstart, How it works, Configuration, Tuning, Operations, Security model and Troubleshooting.

### Files

- Migration: `supabase/migrations/20260926000000_otp_guard.sql`
- Edge Functions: `otp-gateway`, `send-sms-hook`, `before-user-created-hook` and `_shared/otp-guard`

[Unreleased]: https://github.com/m4st3rmiau/supabase-otp-guard/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/m4st3rmiau/supabase-otp-guard/releases/tag/v0.1.0
