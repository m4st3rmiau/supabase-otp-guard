# Troubleshooting

Most problems show up as an error in your app or in the Edge Function logs (**Dashboard → Edge Functions → *function* → Logs**). Find the message below.

## Errors your app receives

| Message | What it means | Fix |
|---|---|---|
| `phone_provider_disabled` | Phone sign-in is off, so Supabase refuses before any hook runs. | Turn on **Authentication → Sign In / Providers → Phone** ([Quickstart, step 4b](quickstart.md#4b-turn-on-phone-sign-in)). |
| *Please request a new code from the app.* | A client called Supabase directly, without a permit. | Route it through `createOtpGuardFetch` ([step 6](quickstart.md#step-6--connect-your-app)). |
| *This number can't receive verification codes.* | The country is not allowed, or the number is blocklisted. | Add the country to `otp_guard.allowed_destinations` ([Configuration](configuration.md#2-choose-your-countries)). |
| *Too many attempts. Please try again later.* | A limit was reached. While testing, it is usually your own repeated attempts. | See [Too many attempts while testing](#too-many-attempts-while-testing). |
| *We couldn't verify this request.* | Web request without a valid Turnstile token, or from an origin that is not allowed. | Check `OTP_GUARD_ALLOWED_ORIGINS` and [Turnstile](#turnstile-fails-on-the-web). |
| `Service currently unavailable due to hook` | The SMS provider refused the message. | Look for `provider rejected the message` in the **send-sms-hook** logs: it includes the provider's reason. |
| `WARN the provider did not deliver` in `e2e:mobile` | otp-guard authorized the send; the provider refused it. | Read `provider rejected the message` in the **send-sms-hook** log ([Provider errors](#provider-errors-bird)). |
| `Unexpected status code returned from hook` | A hook answered in a format Supabase does not relay. otp-guard's hooks never do. | Check that no older hook is still configured in **Authentication → Hooks**. |

## Too many attempts while testing

The limits are working. Repeated tests from one computer quickly reach the signup limit (3 per IP every 30 minutes on `strict`) or the per-phone limits. On a **test project only**, clear the counters:

```sql
TRUNCATE otp_guard.sends, otp_guard.permits, otp_guard.device_phones, otp_guard.signup_attempts;
```

## Provider errors (Bird)

The **send-sms-hook** log `provider rejected the message` shows Bird's own reason:

| Bird says | Meaning |
|---|---|
| `402 billing_error` | The workspace wallet is empty. Top it up. |
| `422 validation_error` | The message, template or destination is not accepted. The log has Bird's full explanation. |
| `429` | Bird's own rate limit. |

## Turnstile fails on the web

The gateway checks that Cloudflare reports one of your hostnames. By default those are the hosts in `OTP_GUARD_ALLOWED_ORIGINS`. Cloudflare's **test keys** report a hostname of their own, so while you use them, add it to `OTP_GUARD_TURNSTILE_HOSTNAMES`. If you set `OTP_GUARD_TURNSTILE_ACTIONS`, the widget's `action` must be in that list.

Remember that each token works once. Ask the widget for a fresh one before every send (see the [example](../examples/nextjs/turnstile.ts)).

## The CLI says your account lacks privileges

*"Your account does not have the necessary privileges to access this endpoint"* means the CLI is logged in to a different Supabase account than the one that owns the project. Either run `supabase login` with the right account, or use that account's token for the current terminal:

```bash
export SUPABASE_ACCESS_TOKEN=sbp_...
```

## `npm run verify` reports a problem

| Result | Fix |
|---|---|
| `otp_guard_status is not callable` | The migration is not applied. [Step 2](quickstart.md#step-2--create-the-database-pieces). |
| `allowed_destinations is empty` | Add at least one country. |
| `anon can call otp_guard_create_permit` | Run the migration's privileges block again. |
| `a client-supplied X-Forwarded-For reached the gateway` | **Do not deploy.** IP limits could be bypassed. Check for a proxy in front of Supabase. |
| `IP check skipped` | Set `OTP_GUARD_DIAGNOSTICS=true` while the checker runs, then unset it. |
| A hook or the phone provider is not enabled | [Step 4](quickstart.md#step-4--turn-on-the-auth-settings). |

Still stuck? Open an issue with the error message and the relevant log lines. Never include secrets, keys or real phone numbers.
