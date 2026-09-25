import { test } from "node:test"
import assert from "node:assert/strict"
import { createSendSmsHandler } from "../../supabase/functions/send-sms-hook/handler.ts"
import type { OtpProvider } from "../../supabase/functions/send-sms-hook/providers/types.ts"
import { HOOK_SECRET, allow, recordingRpc, refuse, signedRequest, silentLog, outcome } from "./helpers.ts"

const USER = "11111111-1111-4111-8111-111111111111"
const payload = (overrides: Record<string, unknown> = {}) => ({
  user: { id: USER, phone: "525500000001" },
  sms: { otp: "123456", phone: "525500000001" },
  ...overrides,
})

function setup({ decision = allow() as unknown, env = {} as Record<string, string>, delivery = { ok: true } as unknown } = {}) {
  const sent: { phone: string; otp: string }[] = []
  const provider: OtpProvider = {
    name: "fake",
    async send(phone, otp) { sent.push({ phone, otp }); return delivery as never },
  }
  const { rpc, calls } = recordingRpc({ otp_guard_authorize_send: decision })
  const log = silentLog()
  const handle = createSendSmsHandler({
    env: key => ({ SEND_SMS_HOOK_SECRET: HOOK_SECRET, ...env })[key],
    rpc, log, provider: () => provider,
  })
  return { handle, sent, calls, log }
}

test("delivers only after an explicit allow", async () => {
  const { handle, sent, calls } = setup()
  const response = await handle(await signedRequest(payload()))
  assert.equal(response.status, 200)
  assert.deepEqual(calls, [{ fn: "otp_guard_authorize_send", args: { p_phone: "525500000001", p_user_id: USER } }])
  assert.deepEqual(sent, [{ phone: "+525500000001", otp: "123456" }])
})

test("unsigned, stale or wrongly signed requests never reach the database", async () => {
  const { handle, calls, sent } = setup()
  const unsigned = new Request("https://example.invalid", { method: "POST", body: JSON.stringify(payload()) })
  assert.equal((await handle(unsigned)).status, 401)
  assert.equal((await handle(await signedRequest(payload(), { age: 600 }))).status, 401)
  const other = `v1,whsec_${Buffer.from("another-secret-another-secret-32").toString("base64")}`
  assert.equal((await handle(await signedRequest(payload(), { secret: other }))).status, 401)
  assert.equal(calls.length + sent.length, 0)
})

test("a refusal is relayed without contacting the provider", async () => {
  const { handle, sent } = setup({ decision: refuse("SEND_PERMIT_REQUIRED") })
  const response = await handle(await signedRequest(payload()))
  assert.equal(await outcome(response), 403)
  assert.equal(response.headers.get("retry-after"), null)
  assert.match((await response.json()).error.message, /new code/)
  assert.equal(sent.length, 0)
})

test("fails closed when the decision is missing or malformed", async () => {
  for (const decision of [new Error("timeout"), null, { allowed: "yes" }, { allowed: true, reason: "X", retry_after: 0 }]) {
    const { handle, sent } = setup({ decision })
    assert.equal(await outcome(await handle(await signedRequest(payload()))), 503)
    assert.equal(sent.length, 0)
  }
})

test("a phone change delivers to the new number, never the registered one", async () => {
  const { handle, sent } = setup()
  await handle(await signedRequest(payload({
    user: { id: USER, phone: "525500000001", new_phone: "525500000002" },
    sms: { otp: "654321", phone: "525500000002", sms_type: "phone_change" },
  })))
  assert.equal(sent[0].phone, "+525500000002")

  const missing = setup()
  const response = await missing.handle(await signedRequest(payload({
    user: { id: USER, phone: "525500000001" }, sms: { otp: "1", sms_type: "phone_change" },
  })))
  assert.equal(await outcome(response), 400)
  assert.equal(missing.sent.length, 0)
})

test("a non-UUID user id is not forwarded as an account", async () => {
  const { handle, calls } = setup()
  await handle(await signedRequest(payload({ user: { id: "nope", phone: "525500000001" } })))
  assert.equal(calls[0].args.p_user_id, null)
})

test("provider failures and rate limits are relayed, never retried by Auth", async () => {
  const failed = setup({ delivery: { ok: false, rateLimited: false, detail: { status: 500 } } })
  assert.equal(await outcome(await failed.handle(await signedRequest(payload()))), 424,
    "never 5xx: Supabase re-runs the request on any 5xx, and the used permit makes the rerun fail")

  const limited = setup({ delivery: { ok: false, rateLimited: true, retryAfter: "12" } })
  const response = await limited.handle(await signedRequest(payload()))
  assert.equal(await outcome(response), 429)
  assert.equal(response.status, 200, "429/503 would make Auth retry a send whose permit is already consumed")
})

test("missing hook secret refuses everything", async () => {
  const { rpc } = recordingRpc({})
  const handle = createSendSmsHandler({ env: () => undefined, rpc, log: silentLog(),
    provider: () => { throw new Error("unused") } })
  assert.equal(await outcome(await handle(await signedRequest(payload()))), 503)
})
