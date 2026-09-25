# supabase-otp-guard

Abuse protection for Supabase phone OTP.

**No permit → no SMS → no bill.**

SMS pumping works because every request to `signInWithOtp` can make your provider send
a paid message. otp-guard puts a gate in front of that: a message only goes out if a
one-time permit was issued for it, and a permit is only issued after rate limits,
destination rules and risk checks pass.

```
Without otp-guard                     With otp-guard

App ──► Supabase Auth ──► Provider    App ──► otp-gateway ──► Supabase Auth ──► Send SMS hook ──► Provider
                           $$$                 │  IP, device, phone,                  │
                                               │  destination, captcha                │  consume permit,
                                               ▼                                      ▼  reserve quota
                                         one-time permit ─────────────────────► no permit = no send
```

> **Status: 0.1, pre-release.** Tested against a real PostgreSQL, in Node and in Deno,
> and deployed on a live Supabase project, where `scripts/verify.mjs` passes and the
> core claim holds: a direct call to `/auth/v1/otp` without a permit is refused by the
> hook and nothing is sent. Delivery through Bird from this repository has not been
> confirmed yet (the same provider code runs in production elsewhere).
> `@otp-guard/client` is not on npm yet; copy `packages/client/src/index.ts` meanwhile.
> Try it on a staging project first.

This is a **template repository**, not a package you install and forget. You copy the
SQL and the Edge Functions into your project, read them, and tune them. Only the small
client helper is published to npm.

## What it does

- **One-time send permits.** The Send SMS hook refuses to deliver without a permit from
  the gateway. Calling `/auth/v1/otp` directly gets the attacker nothing.
- **Atomic quotas.** Per phone, per account, per device and a project-wide spend
  ceiling, reserved in one transaction so concurrent requests cannot overshoot.
- **Rate limits by origin and device.** IPv4 host or IPv6 /64, plus an installation ID.
- **Destination rotation detection.** An origin or device cycling through numbers is
  refused new ones. A device that received codes for two numbers that never verified
  cannot request a third.
- **Destination allowlist and blocklist.** Nothing is sent to a country you did not
  enable, before Auth even creates the account.
- **Risk events and automatic blocks.** Repeated rejections flag and then block the IP
  or device, with a manual release that keeps the history.
- **Signup limits** in the Before User Created hook, with a slot for your own rules.
- **Turnstile for web**, verified by the gateway.

It was extracted from a production app after real SMS pumping incidents. The code here
is a clean rewrite of that system with the thresholds made configurable; the `strict`
preset keeps the values that ran in production.

## What it does not do

Read [docs/threat-model.md](docs/threat-model.md) before relying on it. In short:

- It does not stop a determined attacker using real devices, real numbers and many
  residential IPs. It makes each attempt cost them, and caps what they can cost you.
- The device ID is client-supplied. It catches lazy rotation, not a forged ID per request.
- Native apps have no attestation yet (App Attest / Play Integrity). A script can claim
  to be your mobile app and skip the web captcha. Web-only projects should turn the
  mobile path off.
- It does not protect against phone number enumeration.
- It does not measure delivery or conversion. Your provider's dashboard is still the
  place to spot a pumping pattern it missed.

## Quickstart

```bash
# 1. Copy into your project
cp supabase/migrations/20260926000000_otp_guard.sql <your-project>/supabase/migrations/
cp -r supabase/functions/_shared/otp-guard <your-project>/supabase/functions/_shared/
cp -r supabase/functions/{otp-gateway,send-sms-hook,before-user-created-hook} <your-project>/supabase/functions/

# 2. Apply and choose your countries
supabase db push
# then, in the SQL editor:
#   INSERT INTO otp_guard.allowed_destinations (prefix, digits, label) VALUES ('52', 12, 'Mexico');

# 3. Deploy
supabase functions deploy otp-gateway --no-verify-jwt
supabase functions deploy send-sms-hook --no-verify-jwt
supabase functions deploy before-user-created-hook --no-verify-jwt

# 4. Route the client through the gateway
npm install @otp-guard/client          # or copy packages/client/src/index.ts until it is published
```

```ts
import { createClient } from "@supabase/supabase-js"
import { browserDeviceId, createOtpGuardFetch } from "@otp-guard/client"

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: {
    fetch: createOtpGuardFetch({ supabaseUrl: SUPABASE_URL, platform: "web", getDeviceId: browserDeviceId() }),
  },
})
// signInWithOtp, signUp, resend, updateUser({ phone }), reauthenticate and MFA phone
// challenges work exactly as before.
```

Then enable both Auth hooks, set the secrets and run `npm run verify`. The full
walkthrough is in [docs/quickstart.md](docs/quickstart.md).

## Docs

| | |
|---|---|
| [Quickstart](docs/quickstart.md) | Install, configure, deploy, verify |
| [Architecture](docs/architecture.md) | The request flow, the permit, locks and failure modes |
| [Configuration](docs/configuration.md) | Every setting, destinations, environment variables |
| [Tuning](docs/tuning.md) | Choosing thresholds for your traffic |
| [Threat model](docs/threat-model.md) | What is covered, what is not, and why |
| [Operations](docs/operations.md) | Monitoring, incidents, releasing a block |

## Development

```bash
npm install
npm test            # SQL (embedded Postgres), Edge Function handlers, client
npm run typecheck
npm run smoke:deno  # boots each function in Deno; needs deno on PATH
```

CI runs all three, plus `deno check` on the entrypoints, on every push and pull request.

The SQL tests start a throwaway PostgreSQL; nothing connects to a real project and no
SMS is sent.

## License

MIT
