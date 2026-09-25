# @otp-guard/client

Client helper for [supabase-otp-guard](../../README.md). It routes the Supabase Auth
requests that send a code by phone through the `otp-gateway` Edge Function. Everything
else, including email OTP and `verifyOtp`, goes out untouched.

```ts
import { createClient } from "@supabase/supabase-js"
import { browserDeviceId, createOtpGuardFetch } from "@otp-guard/client"

const supabase = createClient(url, anonKey, {
  global: { fetch: createOtpGuardFetch({ supabaseUrl: url, platform: "web", getDeviceId: browserDeviceId() }) },
})
```

Guarded requests:

- `POST /otp`, `POST /signup`, `POST /resend` and `PUT /user`, when the body has a `phone`
- `GET /reauthenticate` and `POST /factors/{id}/challenge`, always. The gateway checks
  with Auth whether an SMS is involved and forwards the rest untouched.

Not on npm yet: until it is, copy `src/index.ts` into your app. It has no dependencies.

| Export | |
|---|---|
| `createOtpGuardFetch(options)` | A `fetch` for supabase-js `global.fetch` |
| `createDeviceId(storage, key?)` | Per-installation UUID persisted with your storage |
| `browserDeviceId(key?)` | `createDeviceId` over `localStorage`; null during SSR |
| `otpGuardReason(error)` | `"DEVICE_PENDING_VERIFICATION"` etc. from a supabase-js error, or null |
| `isDeviceId(value)` | UUID check |

The device ID is advisory: it helps catch one installation rotating numbers behind
changing IPs. It is not proof of a device.
