// Public entry point for every request that makes Supabase Auth send a code by phone.
// It captures the real client IP, verifies Turnstile for browsers, asks Postgres for a
// one-time permit and only then forwards the request to Auth. The Send SMS hook refuses
// to deliver anything without that permit.

import { decide } from "../_shared/otp-guard/decision.ts"
import { rejection } from "../_shared/otp-guard/messages.ts"
import type { Env, Logger, Rpc } from "../_shared/otp-guard/types.ts"

export type GatewayDeps = { env: Env; rpc: Rpc; fetch: typeof fetch; log: Logger }

type JsonRecord = Record<string, unknown>

// Auth endpoints that can end in a phone OTP. "phone" routes name the number in the body;
// the other two text a number Auth already knows (the account's, or an MFA factor's).
const PHONE_ROUTES = new Set(["POST /otp", "POST /signup", "POST /resend", "PUT /user"])
const CHALLENGE_PATH = /^\/factors\/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\/challenge$/i
type Route = "phone" | "reauthenticate" | "challenge"

function routeOf(method: string, path: string): Route | null {
  if (PHONE_ROUTES.has(`${method} ${path}`)) return "phone"
  if (method === "GET" && path === "/reauthenticate") return "reauthenticate"
  if (method === "POST" && CHALLENGE_PATH.test(path)) return "challenge"
  return null
}

/**
 * The number Auth will text for a session route, or null when it will not send an SMS.
 * Mirrors Auth: reauthentication goes to the email when the account has one, and only
 * phone factors are challenged by SMS or WhatsApp.
 */
function smsDestination(route: Route, path: string, authBody: JsonRecord | null, user: unknown): string | null {
  if (!isRecord(user)) return null
  if (route === "reauthenticate") {
    return !user.email && typeof user.phone === "string" && user.phone ? user.phone : null
  }
  const factorId = path.match(CHALLENGE_PATH)?.[1]?.toLowerCase()
  const factor = Array.isArray(user.factors)
    ? user.factors.find(f => isRecord(f) && String(f.id).toLowerCase() === factorId)
    : null
  if (!isRecord(factor) || factor.factor_type !== "phone") return null
  if (authBody?.channel !== undefined && !["sms", "whatsapp"].includes(String(authBody.channel))) return null
  return typeof factor.phone === "string" && factor.phone ? factor.phone : null
}

const FORWARDED_QUERY = new Set(["redirect_to"])
const FORWARDED_HEADERS = ["authorization", "x-client-info", "x-supabase-api-version"]
const ALLOWED_HEADERS = [
  "authorization", "apikey", "content-type", "x-client-info", "x-supabase-api-version",
  "x-otp-guard-platform", "x-otp-guard-device",
].join(", ")

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function csv(value: string | undefined) {
  return (value ?? "").split(",").map(item => item.trim()).filter(Boolean)
}

// Supabase's edge overwrites X-Forwarded-For, so its first entry is the connecting
// address. scripts/verify.mjs checks that this still holds for your project.
function clientIp(req: Request) {
  return (req.headers.get("x-forwarded-for") ?? "").split(",").map(value => value.trim()).find(Boolean) ?? ""
}

export function createGatewayHandler({ env, rpc, fetch, log }: GatewayDeps) {
  async function verifyTurnstile(token: string, ip: string, allowedOrigins: string[]) {
    const secret = env("TURNSTILE_SECRET_KEY")
    if (!secret) return "turnstile_not_configured"
    if (!token) return "turnstile_missing_token"
    const hostnames = new Set(csv(env("OTP_GUARD_TURNSTILE_HOSTNAMES")).map(h => h.toLowerCase()))
    if (hostnames.size === 0) {
      for (const origin of allowedOrigins) {
        try { hostnames.add(new URL(origin).hostname.toLowerCase()) } catch { /* ignored */ }
      }
    }
    const actions = new Set(csv(env("OTP_GUARD_TURNSTILE_ACTIONS")))
    try {
      const form = new FormData()
      form.set("secret", secret)
      form.set("response", token)
      if (ip) form.set("remoteip", ip)
      const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST", body: form, signal: AbortSignal.timeout(5000),
      })
      const result = await response.json() as JsonRecord
      if (result.success !== true) return "turnstile_failed"
      if (!hostnames.has(String(result.hostname ?? "").toLowerCase())) return "turnstile_hostname_mismatch"
      if (actions.size > 0 && !actions.has(String(result.action ?? ""))) return "turnstile_action_mismatch"
      return null
    } catch {
      return "turnstile_unavailable"
    }
  }

  return async function handle(req: Request): Promise<Response> {
    const origin = req.headers.get("Origin")
    const allowedOrigins = csv(env("OTP_GUARD_ALLOWED_ORIGINS"))
    const cors: Record<string, string> = {
      "Access-Control-Allow-Headers": ALLOWED_HEADERS,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Vary": "Origin",
      ...(origin && allowedOrigins.includes(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
    }
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } })
    // Same shape as a Supabase Auth error, so supabase-js surfaces `msg` and `error_code`.
    const reject = (reason: string, retryAfter = 0) => {
      const { status, message } = rejection(reason)
      return reply(status, {
        code: status, error_code: `otp_guard_${reason.toLowerCase()}`, msg: message, retry_after: retryAfter,
      })
    }

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })
    if (req.method !== "POST") return reject("INVALID_REQUEST")

    const ip = clientIp(req)
    if (env("OTP_GUARD_DIAGNOSTICS") === "true" && req.headers.get("x-otp-guard-diagnose") === "ip") {
      return reply(200, { ip })
    }

    const platform = req.headers.get("x-otp-guard-platform")?.trim().toLowerCase()
    if (platform !== "web" && platform !== "mobile") return reject("INVALID_PLATFORM")
    if (platform === "web" && (!origin || !allowedOrigins.includes(origin))) return reject("INVALID_ORIGIN")
    // Browsers always send Origin on this request, so a page cannot pose as the native app.
    // Scripts can: that is why web-only projects should set OTP_GUARD_MOBILE=off.
    if (platform === "mobile") {
      if (env("OTP_GUARD_MOBILE") === "off") return reject("MOBILE_DISABLED")
      if (origin) return reject("INVALID_ORIGIN")
    }

    let body: JsonRecord
    try {
      const parsed = await req.json()
      if (!isRecord(parsed)) throw new Error("not an object")
      body = parsed
    } catch {
      return reject("INVALID_REQUEST")
    }
    const method = String(body.method ?? "").toUpperCase()
    const path = String(body.path ?? "")
    const authBody = isRecord(body.body) ? body.body : null
    const route = routeOf(method, path)
    if (!route || (route === "phone" && typeof authBody?.phone !== "string")) return reject("INVALID_REQUEST")

    const supabaseUrl = env("SUPABASE_URL")?.replace(/\/$/, "")
    const anonKey = env("SUPABASE_ANON_KEY")
    if (!supabaseUrl || !anonKey || !ip) {
      log.error("missing configuration", { hasUrl: Boolean(supabaseUrl), hasAnonKey: Boolean(anonKey), hasIp: Boolean(ip) })
      return reject("UNAVAILABLE")
    }

    const headers = new Headers({ "apikey": anonKey, "Content-Type": "application/json" })
    for (const name of FORWARDED_HEADERS) {
      const value = req.headers.get(name)
      if (value) headers.set(name, value)
    }
    if (!headers.has("authorization")) headers.set("authorization", `Bearer ${anonKey}`)

    // Session routes carry no phone: Auth sends to the number on the account or factor.
    // Ask Auth, with the caller's own session, which number that is and whether this
    // request will text it at all.
    let phone: string | null = route === "phone" ? String(authBody?.phone) : null
    if (route !== "phone") {
      const user = await fetch(`${supabaseUrl}/auth/v1/user`, { headers, signal: AbortSignal.timeout(5000) })
        .catch(() => null)
      if (!user) return reject("UNAVAILABLE")
      if (!user.ok) {
        // Not signed in, or an expired session: Auth's own error, unchanged.
        return new Response(await user.text(), { status: user.status, headers: { ...cors, "Content-Type": "application/json" } })
      }
      phone = smsDestination(route, path, authBody, await user.json().catch(() => null))
    }

    // Turnstile guards issuing codes to arbitrary numbers. Session routes only text the
    // caller's own verified number, and supabase-js sends no captcha token for them.
    if (platform === "web" && route === "phone") {
      const captcha = env("OTP_GUARD_WEB_CAPTCHA") ?? "turnstile"
      if (captcha === "turnstile") {
        const security = isRecord(authBody?.gotrue_meta_security) ? authBody.gotrue_meta_security : {}
        const failure = await verifyTurnstile(
          typeof security.captcha_token === "string" ? security.captcha_token : "", ip, allowedOrigins)
        if (failure) {
          log.warn("captcha rejected", { reason: failure })
          return reject(failure === "turnstile_not_configured" || failure === "turnstile_unavailable"
            ? "UNAVAILABLE" : "CAPTCHA_FAILED")
        }
      } else if (captcha !== "off") {
        log.error("OTP_GUARD_WEB_CAPTCHA must be 'turnstile' or 'off'", { value: captcha })
        return reject("UNAVAILABLE")
      }
    }

    // No SMS involved (email reauthentication, TOTP challenge): forward without a permit.
    let permitId: string | null = null
    if (phone) {
      const decision = await decide(rpc, "otp_guard_create_permit", {
        p_phone: phone,
        p_ip: ip,
        p_device_id: req.headers.get("x-otp-guard-device"),
        p_client_platform: platform,
      })
      if (!decision) {
        log.error("permit unavailable, refusing to contact Auth")
        return reject("UNAVAILABLE")
      }
      if (!decision.allowed) {
        log.warn("permit rejected", { reason: decision.reason, platform, route })
        return reject(decision.reason ?? "UNAVAILABLE", decision.retryAfter)
      }
      permitId = String(decision.data.permit_id ?? "")
      if (route === "phone" && typeof decision.data.phone === "string") phone = decision.data.phone
    }

    const revoke = async () => {
      if (!permitId) return
      try {
        await rpc("otp_guard_revoke_permit", { p_permit_id: permitId })
      } catch {
        // The permit expires on its own; a failed revoke cannot extend anyone's access.
      }
    }

    const target = new URL(`${supabaseUrl}/auth/v1${path}`)
    if (isRecord(body.query)) {
      for (const [key, value] of Object.entries(body.query)) {
        if (FORWARDED_QUERY.has(key) && typeof value === "string") target.searchParams.set(key, value)
      }
    }
    // Lets Auth's own IP rate limits see the client when the project honors this header.
    // otp-guard does not rely on it: the permit already carries the real IP.
    headers.set("sb-forwarded-for", ip)

    try {
      const response = await fetch(target, {
        method,
        headers,
        body: method === "GET" ? undefined
          : JSON.stringify(route === "phone" ? { ...authBody, phone } : authBody ?? {}),
        signal: AbortSignal.timeout(10000),
      })
      const text = await response.text()
      if (!response.ok) await revoke()
      else log.info("request forwarded", { platform, path: route === "challenge" ? "/factors/:id/challenge" : path })
      return new Response(text || "{}", {
        status: response.status,
        headers: { ...cors, "Content-Type": response.headers.get("Content-Type") ?? "application/json" },
      })
    } catch (error) {
      await revoke()
      log.error("Auth request failed", error)
      return reject("UNAVAILABLE")
    }
  }
}
