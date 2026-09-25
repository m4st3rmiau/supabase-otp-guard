# Configuration

## Settings

All thresholds live in `otp_guard.settings`. Change one with SQL; it applies to the
next request, no deploy needed:

```sql
UPDATE otp_guard.settings SET value = 100, updated_at = now() WHERE key = 'global.sends_per_day';
SELECT key, value, description FROM otp_guard.settings ORDER BY key;
```

Or apply a preset. `p_overwrite => false` only adds missing keys:

```sql
SELECT otp_guard.apply_preset('strict');        -- the values that ran in production
SELECT otp_guard.apply_preset('balanced');
SELECT otp_guard.apply_preset('high-volume');
SELECT otp_guard.apply_preset('strict', p_overwrite => false);
```

Values must be positive. There is no "0 disables" setting: to relax a rule, raise it.
A missing key makes the functions raise, and the Edge Functions answer 503.

| Key | strict | balanced | high-volume | Meaning |
|---|---:|---:|---:|---|
| `permit.ttl_seconds` | 60 | 60 | 60 | Permit validity |
| `origin.permits_per_minute` | 3 | 5 | 10 | Per IPv4 host / IPv6 /64 |
| `origin.permits_per_30_minutes` | 5 | 10 | 30 | |
| `origin.permits_per_day` | 10 | 30 | 100 | |
| `origin.phones_per_30_minutes` | 3 | 4 | 10 | Distinct phones per origin |
| `origin.phones_per_day` | 5 | 10 | 30 | |
| `device.permits_per_minute` | 3 | 3 | 5 | Per installation ID |
| `device.permits_per_day` | 10 | 15 | 20 | |
| `device.pending_phones` | 2 | 2 | 3 | Unverified phones before a new one is refused |
| `device.pending_lookback_days` | 90 | 90 | 30 | How long an unverified phone counts |
| `device.sends_per_day` | 10 | 15 | 20 | Sends per installation |
| `phone.sends_per_minute` | 1 | 1 | 1 | Per destination |
| `phone.sends_per_30_minutes` | 5 | 5 | 5 | |
| `phone.sends_per_day` | 15 | 15 | 15 | |
| `account.sends_per_minute` | 1 | 1 | 1 | Per Auth user |
| `account.sends_per_30_minutes` | 5 | 5 | 5 | |
| `account.sends_per_day` | 15 | 15 | 15 | |
| `account.phones_per_day` | 3 | 3 | 3 | Distinct destinations per user |
| `global.sends_per_minute` | 5 | 30 | 200 | Project-wide spend ceiling |
| `global.sends_per_hour` | 20 | 300 | 3000 | |
| `global.sends_per_day` | 60 | 1500 | 20000 | |
| `global.warn_percent` | 80 | 80 | 80 | When `near_limit` is logged |
| `signup.origin_per_30_minutes` | 3 | 5 | 20 | New users per origin |
| `signup.origin_per_day` | 10 | 30 | 100 | |
| `signup.device_per_day` | 3 | 3 | 5 | |
| `risk.window_minutes` | 60 | 60 | 60 | Risk scoring window |
| `risk.suspicious_rejections` / `_targets` | 6 / 3 | 6 / 3 | 10 / 5 | Flag IP or device |
| `risk.high_rejections` / `_targets` | 20 / 8 | 20 / 8 | 40 / 15 | Block IP or device |
| `risk.device_suspicious_rejections` | 10 | 10 | 15 | Flag device on volume alone |
| `risk.device_high_rejections` | 20 | 20 | 30 | Block device on volume alone |
| `risk.device_pending_rotation` | 3 | 3 | 3 | Pending-verification refusals that block a device |
| `retention.hours` | 24 | 24 | 24 | Minimum 24 |

Only `strict` has run in production. The others are reasoned starting points; see
[tuning.md](tuning.md).

## Destinations

```sql
-- Allow: prefix is E.164 digits without "+", digits is the full length without "+".
INSERT INTO otp_guard.allowed_destinations (prefix, digits, label) VALUES
  ('52', 12, 'Mexico'),
  ('34', 11, 'Spain');

-- Block, even inside an allowed country. Literal prefix with "+".
INSERT INTO otp_guard.blocked_prefixes (prefix, reason) VALUES
  ('+5255123', 'range seen in incident 2026-10-01');
```

Leave `digits` NULL for countries with variable-length numbers.

**+1 is more than the US.** The North American Numbering Plan includes Canada and many
Caribbean countries, some of them classic pumping destinations. If you allow `'1'`,
consider allowing specific area codes instead (`'1415'`, `'1212'`, …), or block the
ranges you do not serve.

## Environment variables

### otp-gateway

| Variable | Default | |
|---|---|---|
| `OTP_GUARD_ALLOWED_ORIGINS` | empty | Comma-separated web origins. Empty refuses all web requests |
| `OTP_GUARD_WEB_CAPTCHA` | `turnstile` | `turnstile` or `off`. Anything else fails closed |
| `TURNSTILE_SECRET_KEY` | | Required with `turnstile` |
| `OTP_GUARD_TURNSTILE_HOSTNAMES` | hosts of the allowed origins | Hostnames siteverify must report |
| `OTP_GUARD_TURNSTILE_ACTIONS` | any | If set, the widget `action` must be one of these |
| `OTP_GUARD_MOBILE` | allowed | `off` refuses the mobile platform |
| `OTP_GUARD_DIAGNOSTICS` | off | `true` enables the IP echo used by `scripts/verify.mjs`. Turn off after |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | injected | |

### send-sms-hook

| Variable | |
|---|---|
| `SEND_SMS_HOOK_SECRET` | `v1,whsec_...` from the hook settings |
| `BIRD_*` | See [providers](#providers) |

### before-user-created-hook

| Variable | |
|---|---|
| `BEFORE_USER_CREATED_HOOK_SECRET` | `v1,whsec_...` from the hook settings |

## Providers

The hook depends on one interface, in `send-sms-hook/providers/types.ts`:

```ts
interface OtpProvider {
  readonly name: string
  send(phone: string, otp: string): Promise<DeliveryResult>
}
```

**Bird** is the only adapter shipped, because it is the only one that has run in
production. Variables: `BIRD_API_KEY`, `BIRD_REGION` (`us1`), `BIRD_CHANNEL` (`sms` or
`whatsapp`), `BIRD_SMS_TEMPLATE`, `BIRD_SMS_LANGUAGE`, `BIRD_SMS_TTL_MINUTES`,
`BIRD_SMS_FROM`, `BIRD_SMS_TEXT`, `BIRD_WHATSAPP_TEMPLATE`, `BIRD_WHATSAPP_LANGUAGE`.
Details in `providers/bird.ts`.

To add one, implement `OtpProvider` and swap it in `send-sms-hook/index.ts`. Use the
provider's **messaging** API, not a "verify" product: verify products generate their own
code, which conflicts with the code Auth generated. Contributions welcome, with a note
on whether the adapter has run in production.

## Messages

User-facing text is in `_shared/otp-guard/messages.ts`. Edit it, or map the reason in
the client:

```ts
import { otpGuardReason } from "@otp-guard/client"

const { error } = await supabase.auth.signInWithOtp({ phone })
switch (otpGuardReason(error)) {
  case "DEVICE_PENDING_VERIFICATION": /* ... */
}
```

`otpGuardReason` reads the gateway's `error_code`. Refusals from the hooks reach the
client through Auth with the status and message from `messages.ts`, but without the
`otp_guard_` code: match those on the message, or rely on the gateway, which catches
almost every limit before Auth runs.
