// Supabase Auth "Before User Created" hook. It runs before the user row exists, which is
// the only point where a signup can be refused outright. otp-guard applies origin and
// device signup limits and destination rules; then your own rules in extensions.ts run.

import { decide } from "../_shared/otp-guard/decision.ts"
import { rejection } from "../_shared/otp-guard/messages.ts"
import type { Env, Logger, Rpc } from "../_shared/otp-guard/types.ts"
import { verifyAuthHook } from "../_shared/otp-guard/webhook.ts"
import type { SignupDenial, SignupUser } from "./extensions.ts"

export type SignupHookDeps = {
  env: Env
  rpc: Rpc
  log: Logger
  customCheck: (user: SignupUser) => Promise<SignupDenial | null>
}

type HookPayload = {
  // This hook, unlike Send SMS, receives the client IP.
  metadata?: { ip_address?: string } | null
  user?: SignupUser | null
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

// Denies the signup. Auth relays the message only when the response is 200 with the error
// in the body: a 4xx becomes a generic 500, and 429/503 make Auth retry the hook.
function deny(status: number, message: string) {
  return json({ error: { http_code: status, message } })
}

export function createSignupHandler({ env, rpc, log, customCheck }: SignupHookDeps) {
  return async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return deny(405, "Method not allowed")
    const secret = env("BEFORE_USER_CREATED_HOOK_SECRET")
    if (!secret) {
      log.error("BEFORE_USER_CREATED_HOOK_SECRET is not set, refusing signups")
      return deny(503, rejection("UNAVAILABLE").message)
    }

    const body = await req.text()
    const check = await verifyAuthHook(req, body, secret)
    if (!check.ok) {
      log.warn("unsigned request rejected", { reason: check.reason })
      // Not Auth calling, so a plain 401: nothing to relay.
      return json({ error: { http_code: 401, message: "Unauthorized" } }, 401)
    }

    let payload: HookPayload
    try {
      payload = JSON.parse(body)
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("not an object")
    } catch {
      return deny(400, rejection("INVALID_REQUEST").message)
    }

    const user = payload.user ?? {}
    const decision = await decide(rpc, "otp_guard_check_signup", {
      p_ip: typeof payload.metadata?.ip_address === "string" ? payload.metadata.ip_address : "",
      p_target: user.phone ? String(user.phone) : String(user.email ?? ""),
    })
    if (!decision) {
      log.error("signup check unavailable, refusing signup")
      return deny(503, rejection("UNAVAILABLE").message)
    }
    if (!decision.allowed) {
      log.warn("signup refused", { reason: decision.reason })
      const { status, message } = rejection(decision.reason)
      return deny(status, message)
    }

    try {
      const denial = await customCheck(user)
      if (denial) {
        log.info("signup refused by custom check", { status: denial.status })
        return deny(denial.status, denial.message)
      }
    } catch (error) {
      log.error("custom signup check failed", error)
      return deny(503, rejection("UNAVAILABLE").message)
    }
    return json({})
  }
}
