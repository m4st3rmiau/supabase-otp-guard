/**
 * Client side of supabase-otp-guard. `createOtpGuardFetch` is passed to supabase-js as
 * its `global.fetch`: phone OTP requests to Auth are rerouted through the otp-gateway
 * Edge Function, everything else goes out untouched. App code keeps calling
 * `signInWithOtp`, `signUp`, `resend` and `updateUser` as before.
 */

export type OtpGuardPlatform = "web" | "mobile"

export type OtpGuardFetchOptions = {
  /** The same URL passed to createClient. */
  supabaseUrl: string
  /** "web" for browsers (Turnstile required by default), "mobile" for native apps. */
  platform: OtpGuardPlatform
  /** Stable per-installation ID, see createDeviceId. Optional but recommended. */
  getDeviceId?: () => string | null | Promise<string | null>
  /** Edge Function name. Default "otp-gateway". */
  gatewayFunction?: string
  /** Underlying fetch. Default globalThis.fetch. */
  fetch?: typeof fetch
}

const DEVICE_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
// Routes that name the phone in the body. Only guarded when they do.
const PHONE_ROUTES = new Set(["POST /otp", "POST /signup", "POST /resend", "PUT /user"])
// Routes that text a number Auth already knows. Always guarded; the gateway checks with
// Auth whether an SMS is involved and forwards the rest without a permit.
const CHALLENGE_PATH = /^\/factors\/[\da-f-]{36}\/challenge$/i
const isSessionRoute = (method: string, path: string) =>
  (method === "GET" && path === "/reauthenticate") || (method === "POST" && CHALLENGE_PATH.test(path))

export function isDeviceId(value: unknown): value is string {
  return typeof value === "string" && DEVICE_ID.test(value)
}

type GatewayRequest = {
  method: string
  path: string
  query: Record<string, string>
  body: Record<string, unknown> | null
}

function parseBody(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "string" || !body) return null
  try {
    const parsed = JSON.parse(body)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function toGatewayRequest(input: unknown, init: RequestInit | undefined, supabaseUrl: string): GatewayRequest | null {
  if (typeof input !== "string" && !(input instanceof URL)) return null
  const url = new URL(String(input))
  const base = new URL(supabaseUrl)
  const authPrefix = `${base.pathname.replace(/\/$/, "")}/auth/v1`
  if (url.origin !== base.origin || !url.pathname.startsWith(`${authPrefix}/`)) return null

  const method = (init?.method ?? "GET").toUpperCase()
  const path = url.pathname.slice(authPrefix.length)
  const query = Object.fromEntries(url.searchParams)
  const body = parseBody(init?.body)

  if (isSessionRoute(method, path)) return { method, path, query, body }
  // Only requests that make Auth text a phone. Email OTP and profile updates pass through.
  if (!PHONE_ROUTES.has(`${method} ${path}`) || typeof body?.phone !== "string" || !body.phone.trim()) return null
  return { method, path, query, body }
}

export function createOtpGuardFetch(options: OtpGuardFetchOptions): typeof fetch {
  const baseFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args))
  const gateway = `${options.supabaseUrl.replace(/\/$/, "")}/functions/v1/${options.gatewayFunction ?? "otp-gateway"}`

  return async (input, init) => {
    const request = toGatewayRequest(input, init, options.supabaseUrl)
    if (!request) return baseFetch(input, init)

    const headers = new Headers(init?.headers)
    headers.set("Content-Type", "application/json")
    headers.set("x-otp-guard-platform", options.platform)
    try {
      const deviceId = await options.getDeviceId?.()
      if (isDeviceId(deviceId)) headers.set("x-otp-guard-device", deviceId)
    } catch {
      // The device ID is an optional signal; losing it must not block sign-in.
    }
    return baseFetch(gateway, { ...init, method: "POST", headers, body: JSON.stringify(request) })
  }
}

export type DeviceIdStorage = {
  get(key: string): string | null | Promise<string | null>
  set(key: string, value: string): void | Promise<void>
}

/**
 * Returns a function that yields one random UUID per installation, persisted with
 * `storage`. It is an advisory identifier: a client can clear or forge it. otp-guard uses
 * it to catch rotation from one installation behind changing IPs, never as proof of a
 * device. If storage fails, the ID lives in memory for the session.
 */
export function createDeviceId(storage: DeviceIdStorage, key = "otp-guard-device-v1"): () => Promise<string | null> {
  let pending: Promise<string | null> | undefined
  return () => {
    pending ??= (async () => {
      let saved: string | null = null
      try { saved = await storage.get(key) } catch { /* fall through to a new ID */ }
      if (isDeviceId(saved)) return saved
      const id = globalThis.crypto.randomUUID()
      try { await storage.set(key, id) } catch { /* keep it in memory */ }
      return id
    })().catch(() => {
      pending = undefined
      return null
    })
    return pending
  }
}

/** localStorage-backed device ID for browsers. Returns null during SSR. */
export function browserDeviceId(key?: string): () => Promise<string | null> {
  if (typeof window === "undefined") return () => Promise.resolve(null)
  return createDeviceId({
    get: k => window.localStorage.getItem(k),
    set: (k, v) => window.localStorage.setItem(k, v),
  }, key)
}

/**
 * The otp-guard reason behind a supabase-js AuthError, e.g. "DEVICE_PENDING_VERIFICATION",
 * or null when the error did not come from otp-guard. Map it to your own copy.
 */
export function otpGuardReason(error: unknown): string | null {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null
  return typeof code === "string" && code.startsWith("otp_guard_") ? code.slice(10).toUpperCase() : null
}
