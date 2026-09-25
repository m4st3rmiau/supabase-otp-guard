# Quickstart

About 20 minutes. You need the Supabase CLI linked to your project and a Bird account.
The gateway works with any provider; Bird is the only adapter shipped today (see
[Configuration → Providers](configuration.md#providers)).

## 1. Copy the files

```bash
cp supabase/migrations/20260926000000_otp_guard.sql <project>/supabase/migrations/
cp -r supabase/functions/_shared/otp-guard <project>/supabase/functions/_shared/
cp -r supabase/functions/otp-gateway supabase/functions/send-sms-hook \
      supabase/functions/before-user-created-hook <project>/supabase/functions/
```

Rename the migration if your project has later ones: Supabase applies them in filename
order. If you already have a `before-user-created-hook`, merge your logic into
`before-user-created-hook/extensions.ts` instead of keeping two hooks.

## 2. Apply the migration

```bash
supabase db push --dry-run   # review
supabase db push
```

It installs the `strict` preset. Now pick where codes may go. **Until you do, every
phone is refused**:

```sql
INSERT INTO otp_guard.allowed_destinations (prefix, digits, label)
VALUES ('52', 12, 'Mexico');   -- +52 followed by 10 digits
```

For higher traffic, start from another preset and read [tuning.md](tuning.md):

```sql
SELECT otp_guard.apply_preset('balanced');
```

## 3. Deploy the functions

```bash
supabase functions deploy otp-gateway --no-verify-jwt
supabase functions deploy send-sms-hook --no-verify-jwt
supabase functions deploy before-user-created-hook --no-verify-jwt
```

`--no-verify-jwt` is intentional. The gateway is public and does its own checks. The
hooks are authenticated by Auth's Standard Webhooks signature, verified in code.

Or in `supabase/config.toml`:

```toml
[functions.otp-gateway]
verify_jwt = false
[functions.send-sms-hook]
verify_jwt = false
[functions.before-user-created-hook]
verify_jwt = false
```

## 4. Enable the Auth hooks

Dashboard → Authentication → Hooks:

- **Send SMS hook** → HTTPS → `https://<ref>.supabase.co/functions/v1/send-sms-hook`.
  Generate the secret and copy it.
- **Before User Created hook** → HTTPS →
  `https://<ref>.supabase.co/functions/v1/before-user-created-hook`. Generate and copy.

Or in `config.toml` (then `supabase config push`). The dashboard route above is the one
verified end to end:

```toml
[auth.hook.send_sms]
enabled = true
uri = "https://<ref>.supabase.co/functions/v1/send-sms-hook"
secrets = "env(SEND_SMS_HOOK_SECRET)"

[auth.hook.before_user_created]
enabled = true
uri = "https://<ref>.supabase.co/functions/v1/before-user-created-hook"
secrets = "env(BEFORE_USER_CREATED_HOOK_SECRET)"
```

Enable **Sign In / Providers → Phone**. Auth refuses every phone request with
`phone_provider_disabled` otherwise, before any hook runs. If the dashboard insists on an
SMS provider, pick any and leave placeholder credentials: with the Send SMS hook enabled,
Auth hands messages to the hook instead. The same through the Management API:
`PATCH /v1/projects/<ref>/config/auth` with `{"external_phone_enabled": true}`.

Keep **Attack Protection → CAPTCHA off** for the project. The gateway verifies Turnstile
itself, and a project-level captcha would verify the same single-use token again and
reject every web login.

## 5. Set the secrets

```bash
cp supabase/functions/.env.example supabase/functions/.env   # git-ignored; fill it in
supabase secrets set --env-file supabase/functions/.env
```

The example file explains where each value comes from. Do not add `SUPABASE_*`
variables: Supabase injects them, and the CLI refuses names with that prefix.

Web-only project? Add `OTP_GUARD_MOBILE=off`. No web app? Leave
`OTP_GUARD_ALLOWED_ORIGINS` empty and every web request is refused. Every variable is
listed in [configuration.md](configuration.md#environment-variables).

## 6. Route the client through the gateway

```bash
npm install @otp-guard/client
```

Until the package is on npm, copy the single file instead. It has no dependencies:

```bash
cp packages/client/src/index.ts <app>/src/lib/otp-guard.ts
```

Web ([full example](../examples/nextjs/supabase.ts), [Turnstile widget](../examples/nextjs/turnstile.ts)):

```ts
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: {
    fetch: createOtpGuardFetch({ supabaseUrl: SUPABASE_URL, platform: "web", getDeviceId: browserDeviceId() }),
  },
})

await supabase.auth.signInWithOtp({ phone, options: { captchaToken } })  // Turnstile token
```

React Native / Expo: see [examples/expo/supabase.ts](../examples/expo/supabase.ts).

Nothing else in your app changes. Email OTP, password sign-in, OAuth and every non-Auth
request go out untouched.

`supabase.auth.reauthenticate()` and MFA phone challenges (`mfa.challenge` on a phone
factor) also send SMS through the hook, so the client routes them through the gateway
too. The gateway asks Auth, with the user's own session, which number will be texted,
and issues a permit for it. Email reauthentication and TOTP challenges are forwarded
without a permit.

## 7. Verify

```bash
cp .env.verify.example .env.verify    # git-ignored; URL, anon key, service role key, access token
supabase secrets set OTP_GUARD_DIAGNOSTICS=true
node --env-file=.env.verify scripts/verify.mjs
supabase secrets unset OTP_GUARD_DIAGNOSTICS
```

It checks that the migration is applied and configured, that API roles cannot call the
entry points, that a forged `X-Forwarded-For` does not reach the gateway, and (with an
access token) that the phone provider and both hooks are enabled and the project
captcha is off. It sends no SMS.

Then send one real code through the mobile path. This costs one message:

```bash
node --env-file=.env.verify scripts/e2e-mobile.mjs +525512345678
```

It checks that a foreign number is refused for free, sends a code through the gateway
and verifies the one you type, then calls `/auth/v1/otp` directly, skipping the
gateway, and confirms that nothing is sent. Test the web path from your app, with
Turnstile.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `phone_provider_disabled` | Phone sign-in is off. Step 4 |
| CLI: "Your account does not have the necessary privileges" | The CLI is logged in to another account. `export SUPABASE_ACCESS_TOKEN=...` for the project's account, or `supabase login` |
| `Service currently unavailable due to hook` | The provider rejected the message. The send-sms-hook log `provider rejected the message` has the provider's reason (for Bird, e.g. 402 `billing_error` is an empty wallet) |
| `Unexpected status code returned from hook` | A hook answered with a non-200 status. otp-guard's hooks never do; check for an older hook still configured |
| `Too many attempts` while testing | Your own limits working: repeated tests from one IP hit `signup.origin_per_30_minutes` or `phone.*`. On a test project: `TRUNCATE otp_guard.sends, otp_guard.permits, otp_guard.device_phones, otp_guard.signup_attempts;` |
| `Please request a new code from the app.` | A client calling Auth directly: route it through `createOtpGuardFetch` |
| Web: 403 right after enabling Turnstile | The siteverify hostname is not allowed. Cloudflare's test keys report their own hostname; add it to `OTP_GUARD_TURNSTILE_HOSTNAMES` while testing |

## Rolling out to existing clients

Once the Send SMS hook is enabled, clients that still call Auth directly get
`SEND_PERMIT_REQUIRED`. Ship the client change first, wait for adoption (OTA for Expo),
then enable the hook. There is deliberately no "permit optional" mode: it would leave
the direct path open for as long as it exists.
