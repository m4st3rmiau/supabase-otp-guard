# Configuration

Three decisions cover almost every project: a **preset**, your **countries** and a few **environment variables**. Everything else has a sensible default.

Limits live in the database, so changing one is a single SQL statement that applies to the next request, with no deploy.

## 1. Pick a preset

| Preset | For | Daily spend ceiling |
|---|---|---:|
| `strict` | A small app, or one that was just attacked. The values that ran in production. | 60 messages |
| `balanced` | A growing app with steady traffic. | 1,500 messages |
| `high-volume` | Thousands of logins a day. | 20,000 messages |

```sql
SELECT otp_guard.apply_preset('balanced');
```

The migration installs `strict`. Applying a preset overwrites every value; to only add settings that are missing, for example after an upgrade, use `SELECT otp_guard.apply_preset('strict', p_overwrite => false);`.

> [!IMPORTANT]
> Only `strict` has run in production. The other two are reasoned starting points. Read [Tuning](tuning.md) and set the spend ceiling from your own numbers.

## 2. Choose your countries

Codes only go to the prefixes you allow. **An empty list refuses every number.**

```sql
-- prefix: country code without "+"   digits: full length without "+"
INSERT INTO otp_guard.allowed_destinations (prefix, digits, label) VALUES
  ('52', 12, 'Mexico'),
  ('34', 11, 'Spain');
```

Leave `digits` empty (`NULL`) for countries whose numbers vary in length.

To block a range or a single number even inside an allowed country, add it with its `+`:

```sql
INSERT INTO otp_guard.blocked_prefixes (prefix, reason) VALUES ('+5255123', 'range seen in an incident');
```

> [!WARNING]
> **`+1` is more than the United States.** It also covers Canada and many Caribbean countries, some of them classic pumping destinations. Rather than allowing `'1'`, allow the area codes you serve (`'1415'`, `'1212'`, …) or block the ranges you do not.

## 3. Set the environment variables

These are Edge Function secrets. The easiest way is the example file, which explains each one: see [Quickstart, step 5](quickstart.md#step-5--add-your-secrets).

**otp-gateway**

| Variable | Default | What it does |
|---|---|---|
| `OTP_GUARD_ALLOWED_ORIGINS` | *(empty)* | Web origins allowed to ask for codes, comma separated. Empty refuses every web request. |
| `OTP_GUARD_WEB_CAPTCHA` | `turnstile` | `turnstile` or `off`. |
| `TURNSTILE_SECRET_KEY` | | Your Turnstile secret. Required with `turnstile`. |
| `OTP_GUARD_TURNSTILE_HOSTNAMES` | hosts of the allowed origins | Hostnames Cloudflare must report. |
| `OTP_GUARD_TURNSTILE_ACTIONS` | *(any)* | If set, the widget's `action` must be one of these. |
| `OTP_GUARD_MOBILE` | *(allowed)* | `off` refuses the mobile path. Use it if you have no native app. |
| `OTP_GUARD_DIAGNOSTICS` | *(off)* | `true` only while running `npm run verify`. |

**send-sms-hook**

| Variable | What it does |
|---|---|
| `SEND_SMS_HOOK_SECRET` | The secret generated when you enabled the hook (`v1,whsec_...`). |
| `BIRD_*` | Your provider settings. See [Providers](#providers). |

**before-user-created-hook**

| Variable | What it does |
|---|---|
| `BEFORE_USER_CREATED_HOOK_SECRET` | The secret generated when you enabled the hook. |

Supabase provides `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` to every function; do not set them yourself.

## Changing a single limit

```sql
UPDATE otp_guard.settings SET value = 100, updated_at = now() WHERE key = 'global.sends_per_day';
SELECT key, value, description FROM otp_guard.settings ORDER BY key;
```

Values must be positive. There is no "0 turns it off": to relax a rule, raise it. If a setting is missing, every request is refused until it is back, so a broken configuration can never open the door.

<details>
<summary><b>Every setting and its value in each preset</b></summary>

**Before Supabase, at the gateway.** An *origin* is one IPv4 address or one IPv6 /64.

| Setting | strict | balanced | high-volume | Meaning |
|---|---:|---:|---:|---|
| `permit.ttl_seconds` | 60 | 60 | 60 | How long a permit stays valid |
| `origin.permits_per_minute` | 3 | 5 | 10 | Requests per origin |
| `origin.permits_per_30_minutes` | 5 | 10 | 30 | |
| `origin.permits_per_day` | 10 | 30 | 100 | |
| `origin.phones_per_30_minutes` | 3 | 4 | 10 | Different numbers per origin |
| `origin.phones_per_day` | 5 | 10 | 30 | |
| `device.permits_per_minute` | 3 | 3 | 5 | Requests per device |
| `device.permits_per_day` | 10 | 15 | 20 | |
| `device.pending_phones` | 2 | 2 | 3 | Unverified numbers before a new one is refused |
| `device.pending_lookback_days` | 90 | 90 | 30 | How long an unverified number counts |

**Before the provider, at the Send SMS hook.**

| Setting | strict | balanced | high-volume | Meaning |
|---|---:|---:|---:|---|
| `phone.sends_per_minute` | 1 | 1 | 1 | Codes per number |
| `phone.sends_per_30_minutes` | 5 | 5 | 5 | |
| `phone.sends_per_day` | 15 | 15 | 15 | |
| `account.sends_per_minute` | 1 | 1 | 1 | Codes per user |
| `account.sends_per_30_minutes` | 5 | 5 | 5 | |
| `account.sends_per_day` | 15 | 15 | 15 | |
| `account.phones_per_day` | 3 | 3 | 3 | Different numbers per user |
| `device.sends_per_day` | 10 | 15 | 20 | Codes per device |
| `global.sends_per_minute` | 5 | 30 | 200 | Spend ceiling for the whole project |
| `global.sends_per_hour` | 20 | 300 | 3000 | |
| `global.sends_per_day` | 60 | 1500 | 20000 | |
| `global.warn_percent` | 80 | 80 | 80 | When to log that the ceiling is near |

**New accounts, at the Before User Created hook.**

| Setting | strict | balanced | high-volume | Meaning |
|---|---:|---:|---:|---|
| `signup.origin_per_30_minutes` | 3 | 5 | 20 | New accounts per origin |
| `signup.origin_per_day` | 10 | 30 | 100 | |
| `signup.device_per_day` | 3 | 3 | 5 | New accounts per device |

**Automatic blocking.**

| Setting | strict | balanced | high-volume | Meaning |
|---|---:|---:|---:|---|
| `risk.window_minutes` | 60 | 60 | 60 | How far back rejections are counted |
| `risk.suspicious_rejections` · `risk.suspicious_targets` | 6 · 3 | 6 · 3 | 10 · 5 | Rejections and different numbers that flag an IP or device |
| `risk.high_rejections` · `risk.high_targets` | 20 · 8 | 20 · 8 | 40 · 15 | Rejections and different numbers that block an IP or device |
| `risk.device_suspicious_rejections` | 10 | 10 | 15 | Rejections alone that flag a device |
| `risk.device_high_rejections` | 20 | 20 | 30 | Rejections alone that block a device |
| `risk.device_pending_rotation` | 3 | 3 | 3 | Refused new numbers that block a device |
| `retention.hours` | 24 | 24 | 24 | How long attempts are kept (minimum 24) |

</details>

## Providers

The Send SMS hook talks to the provider through one small interface, in `send-sms-hook/providers/types.ts`:

```ts
interface OtpProvider {
  readonly name: string
  send(phone: string, otp: string): Promise<DeliveryResult>
}
```

**Bird** is the only adapter included, because it is the only one that has run in production. It sends by SMS or WhatsApp:

| Variable | Default | |
|---|---|---|
| `BIRD_API_KEY` | | Workspace key, `bk_<region>_...` |
| `BIRD_REGION` | `us1` | Must match the key's prefix |
| `BIRD_CHANNEL` | `sms` | `sms` or `whatsapp` |
| `BIRD_SMS_TEMPLATE` · `BIRD_SMS_LANGUAGE` | `bird_otp_verification_ttl` · `en` | Bird's built-in SMS template |
| `BIRD_SMS_TTL_MINUTES` | `5` | Shown in the message; keep it equal to Auth's OTP expiry |
| `BIRD_SMS_FROM` · `BIRD_SMS_TEXT` | | A registered sender and your own text (`{code}` is replaced) |
| `BIRD_WHATSAPP_TEMPLATE` · `BIRD_WHATSAPP_LANGUAGE` | `bird_otp` · `en` | An approved WhatsApp authentication template |

**Adding another provider:** implement `OtpProvider` and swap it in `send-sms-hook/index.ts`. Use the provider's *messaging* API, not a *verify* product: verify products create their own code, which clashes with the one Supabase already created. Contributions are welcome, with a note on whether the adapter has run in production.

## Messages shown to users

Every message lives in `_shared/otp-guard/messages.ts`. Translate or reword them there, or show your own copy by checking the reason in your app:

```ts
import { otpGuardReason } from "@otp-guard/client"

const { error } = await supabase.auth.signInWithOtp({ phone })
if (otpGuardReason(error) === "DEVICE_PENDING_VERIFICATION") {
  // "Verify one of the numbers you already received a code on."
}
```

`otpGuardReason` works for everything the gateway refuses, which is almost every limit. The few refusals that happen later, inside the hooks, reach your app with the status and the text from `messages.ts`, but without the reason code.
