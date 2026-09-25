import { test } from "node:test"
import assert from "node:assert/strict"
import { createDeviceId, createOtpGuardFetch, isDeviceId, otpGuardReason } from "../../packages/client/src/index.ts"

const SUPABASE = "https://project.supabase.co"
const DEVICE = "33333333-3333-4333-8333-333333333333"

function recorder() {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response("{}")
  }) as typeof fetch
  return { calls, fetchImpl }
}

test("phone OTP requests go to the gateway with platform and device", async () => {
  const { calls, fetchImpl } = recorder()
  const guarded = createOtpGuardFetch({ supabaseUrl: SUPABASE, platform: "mobile", getDeviceId: () => DEVICE, fetch: fetchImpl })
  await guarded(`${SUPABASE}/auth/v1/otp?redirect_to=x`, {
    method: "POST", headers: { apikey: "anon", Authorization: "Bearer anon" },
    body: JSON.stringify({ phone: "+525500000001", create_user: true }),
  })
  assert.equal(calls[0].url, `${SUPABASE}/functions/v1/otp-gateway`)
  const headers = new Headers(calls[0].init?.headers)
  assert.equal(headers.get("x-otp-guard-platform"), "mobile")
  assert.equal(headers.get("x-otp-guard-device"), DEVICE)
  assert.equal(headers.get("apikey"), "anon")
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    method: "POST", path: "/otp", query: { redirect_to: "x" }, body: { phone: "+525500000001", create_user: true },
  })
})

test("everything else passes through untouched", async () => {
  const { calls, fetchImpl } = recorder()
  const guarded = createOtpGuardFetch({ supabaseUrl: SUPABASE, platform: "web", fetch: fetchImpl })
  const cases: [string, RequestInit][] = [
    [`${SUPABASE}/auth/v1/otp`, { method: "POST", body: JSON.stringify({ email: "a@example.com" }) }],
    [`${SUPABASE}/auth/v1/verify`, { method: "POST", body: JSON.stringify({ phone: "+525500000001", token: "1" }) }],
    [`${SUPABASE}/auth/v1/user`, { method: "PUT", body: JSON.stringify({ data: { name: "x" } }) }],
    [`${SUPABASE}/rest/v1/profiles`, { method: "POST", body: JSON.stringify({ phone: "+525500000001" }) }],
    ["https://other.example/auth/v1/otp", { method: "POST", body: JSON.stringify({ phone: "+525500000001" }) }],
  ]
  for (const [url, init] of cases) await guarded(url, init)
  assert.deepEqual(calls.map(c => c.url), cases.map(([url]) => url))
})

test("phone change and resend are guarded too", async () => {
  const { calls, fetchImpl } = recorder()
  const guarded = createOtpGuardFetch({ supabaseUrl: SUPABASE, platform: "web", fetch: fetchImpl })
  await guarded(`${SUPABASE}/auth/v1/user`, { method: "PUT", body: JSON.stringify({ phone: "+525500000002" }) })
  await guarded(`${SUPABASE}/auth/v1/resend`, { method: "POST", body: JSON.stringify({ type: "sms", phone: "+525500000002" }) })
  assert.deepEqual(calls.map(c => JSON.parse(String(c.init?.body)).path), ["/user", "/resend"])
})

test("a failing device ID does not block sign-in", async () => {
  const { calls, fetchImpl } = recorder()
  const guarded = createOtpGuardFetch({ supabaseUrl: SUPABASE, platform: "mobile", fetch: fetchImpl,
    getDeviceId: () => { throw new Error("storage") } })
  await guarded(`${SUPABASE}/auth/v1/otp`, { method: "POST", body: JSON.stringify({ phone: "+525500000001" }) })
  assert.equal(new Headers(calls[0].init?.headers).get("x-otp-guard-device"), null)
})

test("device IDs persist and survive broken storage", async () => {
  const store = new Map<string, string>()
  const first = await createDeviceId({ get: k => store.get(k) ?? null, set: (k, v) => { store.set(k, v) } })()
  assert.ok(isDeviceId(first))
  const again = await createDeviceId({ get: k => store.get(k) ?? null, set: () => {} })()
  assert.equal(again, first)
  const broken = await createDeviceId({ get: () => { throw new Error("x") }, set: () => { throw new Error("y") } })()
  assert.ok(isDeviceId(broken))
})

test("otpGuardReason reads supabase-js error codes", () => {
  assert.equal(otpGuardReason({ code: "otp_guard_device_pending_verification" }), "DEVICE_PENDING_VERIFICATION")
  assert.equal(otpGuardReason({ code: "over_sms_send_rate_limit" }), null)
  assert.equal(otpGuardReason(null), null)
})

test("reauthenticate and MFA challenges go to the gateway, MFA verify does not", async () => {
  const { calls, fetchImpl } = recorder()
  const guarded = createOtpGuardFetch({ supabaseUrl: SUPABASE, platform: "mobile", fetch: fetchImpl })
  const factor = "44444444-4444-4444-8444-444444444444"
  await guarded(`${SUPABASE}/auth/v1/reauthenticate`, { method: "GET", headers: { Authorization: "Bearer jwt" } })
  await guarded(`${SUPABASE}/auth/v1/factors/${factor}/challenge`, { method: "POST", body: JSON.stringify({ channel: "sms" }) })
  await guarded(`${SUPABASE}/auth/v1/factors/${factor}/verify`, { method: "POST", body: JSON.stringify({ code: "1" }) })
  assert.equal(calls[0].url, `${SUPABASE}/functions/v1/otp-gateway`)
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { method: "GET", path: "/reauthenticate", query: {}, body: null })
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), "Bearer jwt")
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)).body, { channel: "sms" })
  assert.equal(calls[2].url, `${SUPABASE}/auth/v1/factors/${factor}/verify`)
})
