// Bird (platform.bird.com). Its current API is not the legacy MessageBird protocol that
// Supabase's built-in provider speaks, which is why this goes through the Send SMS hook.
//
// Environment:
//   BIRD_API_KEY            Workspace key, bk_{region}_...
//   BIRD_REGION             Must match the key prefix (default "us1")
//   BIRD_CHANNEL            "whatsapp" or "sms" (default "sms")
//   BIRD_WHATSAPP_TEMPLATE  Authentication template slug (default "bird_otp")
//   BIRD_WHATSAPP_LANGUAGE  Template language (default "en")
//   BIRD_SMS_TEMPLATE       Built-in SMS template (default "bird_otp_verification_ttl")
//   BIRD_SMS_LANGUAGE       Template language (default "en")
//   BIRD_SMS_TTL_MINUTES    Shown in the template; keep in sync with Auth's OTP expiry (default "5")
//   BIRD_SMS_FROM           Registered sender. When set, sends BIRD_SMS_TEXT instead of the template.
//   BIRD_SMS_TEXT           Free text with {code} (default "Your verification code is {code}")
//
// WhatsApp caveat: Bird accepts (202) messages to numbers without WhatsApp and they are
// simply never delivered. There is no automatic SMS fallback on purpose: a fallback would
// double the cost an attacker can cause per permit.

import type { Env } from "../../_shared/otp-guard/types.ts"
import type { DeliveryResult, OtpProvider } from "./types.ts"

// Bird error bodies carry neither the code nor the phone. Keep type and message short.
function errorFields(detail: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(detail)
    const error = parsed && typeof parsed === "object" ? parsed.error ?? parsed : {}
    return {
      birdError: String(error.type ?? error.code ?? "").slice(0, 48),
      birdMessage: String(error.message ?? "").slice(0, 300),
    }
  } catch {
    return { birdMessage: detail.slice(0, 300) }
  }
}

export function createBirdProvider(env: Env, fetchImpl: typeof fetch): OtpProvider {
  const apiKey = env("BIRD_API_KEY")
  const region = env("BIRD_REGION") ?? "us1"
  const channel = (env("BIRD_CHANNEL") ?? "sms").trim().toLowerCase()
  if (!apiKey) throw new Error("BIRD_API_KEY is not set")
  if (channel !== "sms" && channel !== "whatsapp") throw new Error("BIRD_CHANNEL must be sms or whatsapp")

  function message(phone: string, otp: string) {
    if (channel === "whatsapp") {
      const parameters = [{ type: "text", text: otp }]
      return {
        path: "whatsapp/messages",
        body: {
          to: phone,
          template: {
            slug: env("BIRD_WHATSAPP_TEMPLATE") ?? "bird_otp",
            language: env("BIRD_WHATSAPP_LANGUAGE") ?? "en",
            components: [{ type: "body", parameters }, { type: "button", parameters }],
          },
        },
      }
    }
    const from = env("BIRD_SMS_FROM")?.trim()
    // Bird rejects text/from alongside a template, so the two modes are exclusive.
    return {
      path: "sms/messages",
      body: from
        ? {
          to: phone,
          from,
          text: (env("BIRD_SMS_TEXT") ?? "Your verification code is {code}").replaceAll("{code}", otp),
          category: "authentication",
        }
        : {
          to: phone,
          template: {
            name: env("BIRD_SMS_TEMPLATE") ?? "bird_otp_verification_ttl",
            language: env("BIRD_SMS_LANGUAGE") ?? "en",
            parameters: { code: otp, ttl: env("BIRD_SMS_TTL_MINUTES") ?? "5" },
          },
        },
    }
  }

  return {
    name: `bird-${channel}`,
    async send(phone: string, otp: string): Promise<DeliveryResult> {
      const { path, body } = message(phone, otp)
      let response: Response
      try {
        response = await fetchImpl(`https://${region}.platform.bird.com/v1/${path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(8000),
        })
      } catch (error) {
        return { ok: false, rateLimited: false, detail: { network: String((error as Error)?.name ?? error) } }
      }
      const requestId = response.headers.get("x-request-id")
      if (response.ok) return { ok: true, requestId }
      const detail = await response.text().catch(() => "")
      return {
        ok: false,
        rateLimited: response.status === 429,
        retryAfter: response.headers.get("retry-after"),
        detail: { status: response.status, requestId, ...errorFields(detail) },
      }
    },
  }
}
