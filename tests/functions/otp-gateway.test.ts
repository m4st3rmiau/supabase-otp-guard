import { test } from "node:test"
import assert from "node:assert/strict"
import { createGatewayHandler } from "../../supabase/functions/otp-gateway/handler.ts"
import { allow, recordingRpc, refuse, silentLog } from "./helpers.ts"

const PERMIT = { permit_id: "22222222-2222-4222-8222-222222222222", phone: "+525500000001" }
const BASE_ENV: Record<string, string> = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  OTP_GUARD_ALLOWED_ORIGINS: "https://app.example.com",
  TURNSTILE_SECRET_KEY: "turnstile-secret",
}

type Options = {
  env?: Record<string, string | undefined>
  permit?: unknown
  auth?: { status: number; body: string }
  turnstile?: Record<string, unknown>
  user?: { status: number; body: unknown }
}

function setup({ env = {}, permit = allow(PERMIT), auth = { status: 200, body: "{}" },
  turnstile = { success: true, hostname: "app.example.com", action: "login" },
  user = { status: 200, body: {} } }: Options = {}) {
  const { rpc, calls } = recordingRpc({ otp_guard_create_permit: permit, otp_guard_revoke_permit: null })
  const requests: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, init: init ?? {} })
    if (url.includes("challenges.cloudflare.com")) return Response.json(turnstile)
    if (url.endsWith("/auth/v1/user") && !init?.method) return Response.json(user.body, { status: user.status })
    return new Response(auth.body, { status: auth.status, headers: { "Content-Type": "application/json" } })
  }) as typeof fetch
  const merged = { ...BASE_ENV, ...env }
  const handle = createGatewayHandler({ env: key => merged[key], rpc, fetch: fetchImpl, log: silentLog() })
  return { handle, calls, requests }
}

function request({ platform = "mobile", origin, body, headers = {} }: {
  platform?: string; origin?: string; body?: unknown; headers?: Record<string, string>
} = {}) {
  return new Request("https://project.supabase.co/functions/v1/otp-gateway", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "203.0.113.10, 10.0.0.1",
      "x-otp-guard-platform": platform,
      "x-otp-guard-device": "33333333-3333-4333-8333-333333333333",
      ...(origin ? { Origin: origin } : {}),
      ...headers,
    },
    body: JSON.stringify(body ?? { method: "POST", path: "/otp", body: { phone: "+52 55 0000 0001" } }),
  })
}

test("mobile: permit first, then Auth with the normalized phone", async () => {
  const { handle, calls, requests } = setup()
  const response = await handle(request())
  assert.equal(response.status, 200)
  assert.deepEqual(calls, [{ fn: "otp_guard_create_permit", args: {
    p_phone: "+52 55 0000 0001", p_ip: "203.0.113.10",
    p_device_id: "33333333-3333-4333-8333-333333333333", p_client_platform: "mobile" } }])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, "https://project.supabase.co/auth/v1/otp")
  assert.equal(JSON.parse(String(requests[0].init.body)).phone, "+525500000001")
  const headers = new Headers(requests[0].init.headers)
  assert.equal(headers.get("apikey"), "anon-key")
  assert.equal(headers.get("sb-forwarded-for"), "203.0.113.10")
})

test("a refused permit never reaches Auth and returns an Auth-shaped error", async () => {
  const { handle, requests } = setup({ permit: refuse("DEVICE_PENDING_VERIFICATION", 86400) })
  const response = await handle(request())
  assert.equal(response.status, 429)
  const body = await response.json()
  assert.equal(body.error_code, "otp_guard_device_pending_verification")
  assert.equal(body.retry_after, 86400)
  assert.equal(requests.length, 0)
})

test("fails closed when the permit function errors", async () => {
  const { handle, requests } = setup({ permit: new Error("db down") })
  assert.equal((await handle(request())).status, 503)
  assert.equal(requests.length, 0)
})

test("an Auth failure revokes the permit", async () => {
  const { handle, calls } = setup({ auth: { status: 422, body: '{"msg":"nope"}' } })
  const response = await handle(request())
  assert.equal(response.status, 422)
  assert.deepEqual(calls.at(-1), { fn: "otp_guard_revoke_permit", args: { p_permit_id: PERMIT.permit_id } })
})

test("only phone OTP routes are accepted", async () => {
  const { handle, calls } = setup()
  for (const body of [
    { method: "POST", path: "/token", body: { phone: "+525500000001" } },
    { method: "POST", path: "/otp", body: { email: "a@example.com" } },
    { method: "GET", path: "/otp", body: { phone: "+525500000001" } },
    "not json",
  ]) {
    assert.equal((await handle(request({ body }))).status, 400)
  }
  assert.equal(calls.length, 0)
})

test("platform and origin rules", async () => {
  const { handle } = setup()
  assert.equal((await handle(request({ platform: "desktop" }))).status, 400)
  assert.equal((await handle(request({ platform: "mobile", origin: "https://app.example.com" }))).status, 403,
    "a browser cannot pose as the native app")
  assert.equal((await handle(request({ platform: "web" }))).status, 403, "web needs an Origin")
  assert.equal((await handle(request({ platform: "web", origin: "https://evil.example" }))).status, 403)

  const webOnly = setup({ env: { OTP_GUARD_MOBILE: "off" } })
  assert.equal((await webOnly.handle(request())).status, 403)
})

test("web requires a Turnstile token for an allowed hostname", async () => {
  const body = (token?: string) => ({ method: "POST", path: "/otp", body: {
    phone: "+525500000001", ...(token ? { gotrue_meta_security: { captcha_token: token } } : {}) } })
  const web = { platform: "web", origin: "https://app.example.com" }

  const ok = setup()
  const response = await ok.handle(request({ ...web, body: body("token") }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("access-control-allow-origin"), "https://app.example.com")

  assert.equal((await setup().handle(request({ ...web, body: body() }))).status, 403)
  assert.equal((await setup({ turnstile: { success: false } }).handle(request({ ...web, body: body("t") }))).status, 403)
  assert.equal((await setup({ turnstile: { success: true, hostname: "evil.example" } })
    .handle(request({ ...web, body: body("t") }))).status, 403)
  assert.equal((await setup({ env: { OTP_GUARD_TURNSTILE_ACTIONS: "signup" } })
    .handle(request({ ...web, body: body("t") }))).status, 403)
  assert.equal((await setup({ env: { TURNSTILE_SECRET_KEY: undefined } })
    .handle(request({ ...web, body: body("t") }))).status, 503, "misconfigured captcha fails closed")
  assert.equal((await setup({ env: { OTP_GUARD_WEB_CAPTCHA: "off" } })
    .handle(request({ ...web, body: body() }))).status, 200)
})

test("only redirect_to is forwarded from the query", async () => {
  const { handle, requests } = setup()
  await handle(request({ body: { method: "POST", path: "/signup", query: { redirect_to: "https://app.example.com/x", evil: "1" },
    body: { phone: "+525500000001", password: "secret123" } } }))
  assert.equal(requests[0].url, "https://project.supabase.co/auth/v1/signup?redirect_to=https%3A%2F%2Fapp.example.com%2Fx")
})

test("diagnostics echo the IP only when enabled", async () => {
  const off = setup()
  const probe = { "x-otp-guard-diagnose": "ip" }
  assert.equal((await (await off.handle(request({ headers: probe }))).json()).ip, undefined,
    'disabled: treated as a normal OTP request')
  const on = setup({ env: { OTP_GUARD_DIAGNOSTICS: "true" } })
  assert.deepEqual(await (await on.handle(request({ headers: probe }))).json(), { ip: "203.0.113.10" })
})

test("preflight answers allowed origins only", async () => {
  const { handle } = setup()
  const preflight = (origin: string) => handle(new Request("https://x", { method: "OPTIONS", headers: { Origin: origin } }))
  assert.equal((await preflight("https://app.example.com")).headers.get("access-control-allow-origin"), "https://app.example.com")
  assert.equal((await preflight("https://evil.example")).headers.get("access-control-allow-origin"), null)
})

const FACTOR = "44444444-4444-4444-8444-444444444444"
const session = { Authorization: "Bearer user-jwt" }

test("reauthenticate texts the account phone only when there is no email", async () => {
  const phoneOnly = setup({ user: { status: 200, body: { phone: "525500000009", email: "" } } })
  const response = await phoneOnly.handle(request({ headers: session, body: { method: "GET", path: "/reauthenticate" } }))
  assert.equal(response.status, 200)
  assert.equal(phoneOnly.calls[0].args.p_phone, "525500000009")
  const forwarded = phoneOnly.requests.at(-1)!
  assert.equal(forwarded.url, "https://project.supabase.co/auth/v1/reauthenticate")
  assert.equal(forwarded.init.method, "GET")
  assert.equal(forwarded.init.body, undefined)
  assert.equal(new Headers(forwarded.init.headers).get("authorization"), "Bearer user-jwt")

  const withEmail = setup({ user: { status: 200, body: { phone: "525500000009", email: "a@example.com" } } })
  assert.equal((await withEmail.handle(request({ headers: session, body: { method: "GET", path: "/reauthenticate" } }))).status, 200)
  assert.equal(withEmail.calls.length, 0, "email reauthentication needs no permit")
})

test("an MFA phone challenge gets a permit for the factor's number", async () => {
  const user = { factors: [
    { id: FACTOR, factor_type: "phone", phone: "525500000008" },
    { id: "55555555-5555-4555-8555-555555555555", factor_type: "totp" },
  ] }
  const phone = setup({ user: { status: 200, body: user } })
  const path = `/factors/${FACTOR}/challenge`
  assert.equal((await phone.handle(request({ headers: session, body: { method: "POST", path, body: { channel: "sms" } } }))).status, 200)
  assert.equal(phone.calls[0].args.p_phone, "525500000008")
  assert.equal(phone.requests.at(-1)!.url, `https://project.supabase.co/auth/v1${path}`)
  assert.deepEqual(JSON.parse(String(phone.requests.at(-1)!.init.body)), { channel: "sms" })

  const totp = setup({ user: { status: 200, body: user } })
  await totp.handle(request({ headers: session, body: { method: "POST",
    path: "/factors/55555555-5555-4555-8555-555555555555/challenge", body: {} } }))
  assert.equal(totp.calls.length, 0, "TOTP challenges send no SMS and need no permit")
})

test("session routes refused by the permit never reach Auth", async () => {
  const { handle, requests } = setup({ permit: refuse("PHONE_MINUTE_LIMIT", 40),
    user: { status: 200, body: { phone: "525500000009" } } })
  const response = await handle(request({ headers: session, body: { method: "GET", path: "/reauthenticate" } }))
  assert.equal(response.status, 429)
  assert.deepEqual(requests.map(r => r.url), ["https://project.supabase.co/auth/v1/user"])
})

test("session routes without a valid session return Auth's error", async () => {
  const { handle, calls, requests } = setup({ user: { status: 401, body: { msg: "invalid JWT" } } })
  const response = await handle(request({ body: { method: "GET", path: "/reauthenticate" } }))
  assert.equal(response.status, 401)
  assert.equal(calls.length, 0)
  assert.equal(requests.length, 1)
})

test("web session routes skip Turnstile, phone routes do not", async () => {
  const { handle, requests } = setup({ turnstile: { success: false },
    user: { status: 200, body: { phone: "525500000009" } } })
  const response = await handle(request({ platform: "web", origin: "https://app.example.com", headers: session,
    body: { method: "GET", path: "/reauthenticate" } }))
  assert.equal(response.status, 200)
  assert.ok(!requests.some(r => r.url.includes("challenges.cloudflare.com")))
})
