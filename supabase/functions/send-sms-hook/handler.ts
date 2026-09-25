// Supabase Auth "Send SMS" hook. Auth generates and verifies the code; this hook only
// decides whether it may be delivered, and delivers it. The decision is a single call to
// otp_guard_authorize_send, which consumes the gateway permit and reserves quota
// atomically. The provider is never contacted without an explicit allow.

import { decide } from "../_shared/otp-guard/decision.ts"
import { rejection } from "../_shared/otp-guard/messages.ts"
import type { Env, Logger, Rpc } from "../_shared/otp-guard/types.ts"
import { verifyAuthHook } from "../_shared/otp-guard/webhook.ts"
import type { OtpProvider } from "./providers/types.ts"

export type SendHookDeps = { env: Env; rpc: Rpc; log: Logger; provider: () => OtpProvider }

type HookPayload = {
  // On a phone change `user.phone` is still the old number. The new one arrives in
  // `sms.phone` (or `user.new_phone` / `user.phone_change`), and only that one may
  // receive the code: it is the number being proven.
  user?: { id?: string; phone?: string | null; new_phone?: string | null; phone_change?: string | null } | null
  sms?: { otp?: string | null; phone?: string | null; sms_type?: string | null } | null
}

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } })
}

// Auth only relays a hook error to the client when the response is 200 with the error in
// the body. A 4xx becomes a generic 500, and 429/503 make Auth retry the hook, which can
// never succeed here: the permit is already consumed.
function hookError(reason: string) {
  const { status, message } = rejection(reason)
  return json({ error: { http_code: status, message } })
}

export function createSendSmsHandler({ env, rpc, log, provider }: SendHookDeps) {
  return async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return hookError("INVALID_REQUEST")
    const secret = env("SEND_SMS_HOOK_SECRET")
    if (!secret) {
      log.error("SEND_SMS_HOOK_SECRET is not set")
      return hookError("UNAVAILABLE")
    }

    const body = await req.text()
    const check = await verifyAuthHook(req, body, secret)
    if (!check.ok) {
      log.warn("unsigned request rejected", { reason: check.reason })
      return json({ error: { http_code: 401, message: "Unauthorized" } }, 401)
    }

    let payload: HookPayload
    try {
      payload = JSON.parse(body)
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("not an object")
    } catch {
      return hookError("INVALID_REQUEST")
    }

    const smsType = String(payload.sms?.sms_type ?? "").toLowerCase()
    const hookPhone = String(payload.sms?.phone ?? "").trim()
    const pendingPhone = String(payload.user?.new_phone ?? payload.user?.phone_change ?? "").trim()
    const registeredPhone = String(payload.user?.phone ?? "").trim()
    // Never fall back to the registered number on a change: that would hand the code to
    // the current account instead of whoever must prove the new number.
    if (!hookPhone && !pendingPhone && smsType.includes("change")) {
      log.error("phone change without a destination", { smsType })
      return hookError("INVALID_REQUEST")
    }
    const phone = hookPhone || pendingPhone || registeredPhone
    const otp = String(payload.sms?.otp ?? "").trim()
    const userId = String(payload.user?.id ?? "").trim()
    if (!phone || !otp) {
      log.warn("payload without phone or code", { smsType })
      return hookError("INVALID_REQUEST")
    }

    const decision = await decide(rpc, "otp_guard_authorize_send", {
      p_phone: phone,
      p_user_id: UUID.test(userId) ? userId : null,
    })
    if (!decision) {
      log.error("authorization unavailable, provider not contacted")
      return hookError("UNAVAILABLE")
    }
    if (!decision.allowed) {
      log.warn("send refused", { reason: decision.reason, retryAfter: decision.retryAfter, suffix: phone.slice(-4) })
      return hookError(decision.reason ?? "UNAVAILABLE")
    }
    if (decision.data.near_limit === true) log.warn("global quota near its limit", { usage: decision.data.usage })

    let delivery
    try {
      delivery = await provider().send(phone.startsWith("+") ? phone : `+${phone.replace(/\D/g, "")}`, otp)
    } catch (error) {
      log.error("provider misconfigured", error)
      return hookError("PROVIDER_ERROR")
    }
    // The reservation stays consumed on failure: retrying provider errors cannot erase quota.
    if (!delivery.ok) {
      log.error("provider rejected the message", delivery.detail)
      return hookError(delivery.rateLimited ? "PROVIDER_RATE_LIMIT" : "PROVIDER_ERROR")
    }
    log.info("OTP dispatched", { requestId: delivery.requestId ?? null })
    return json({})
  }
}
