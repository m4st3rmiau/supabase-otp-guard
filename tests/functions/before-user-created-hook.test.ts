import { test } from "node:test"
import assert from "node:assert/strict"
import { createSignupHandler } from "../../supabase/functions/before-user-created-hook/handler.ts"
import type { SignupDenial } from "../../supabase/functions/before-user-created-hook/extensions.ts"
import { HOOK_SECRET, allow, recordingRpc, refuse, signedRequest, silentLog, outcome } from "./helpers.ts"

function setup(decision: unknown = allow(), customCheck: () => Promise<SignupDenial | null> = async () => null) {
  const { rpc, calls } = recordingRpc({ otp_guard_check_signup: decision })
  const handle = createSignupHandler({
    env: key => ({ BEFORE_USER_CREATED_HOOK_SECRET: HOOK_SECRET } as Record<string, string>)[key],
    rpc, log: silentLog(), customCheck,
  })
  return { handle, calls }
}

const payload = { metadata: { ip_address: "203.0.113.20" }, user: { phone: "525500000001" } }

test("passes the hook IP and the phone to otp-guard", async () => {
  const { handle, calls } = setup()
  assert.equal(await outcome(await handle(await signedRequest(payload))), 200)
  assert.deepEqual(calls[0].args, { p_ip: "203.0.113.20", p_target: "525500000001" })
})

test("email and anonymous signups are checked by origin", async () => {
  const { handle, calls } = setup()
  await handle(await signedRequest({ metadata: { ip_address: "203.0.113.20" }, user: { email: "a@example.com" } }))
  await handle(await signedRequest({ metadata: { ip_address: "203.0.113.20" }, user: {} }))
  assert.deepEqual(calls.map(c => c.args.p_target), ["a@example.com", ""])
})

test("a refusal denies the signup", async () => {
  const { handle } = setup(refuse("ORIGIN_SIGNUP_LIMIT", 1800))
  const response = await handle(await signedRequest(payload))
  assert.equal(await outcome(response), 429)
  assert.ok((await response.json()).error.message)
})

test("fails closed without a decision or a secret", async () => {
  assert.equal(await outcome(await setup(new Error("down")).handle(await signedRequest(payload))), 503)
  const { rpc } = recordingRpc({})
  const noSecret = createSignupHandler({ env: () => undefined, rpc, log: silentLog(), customCheck: async () => null })
  assert.equal(await outcome(await noSecret(await signedRequest(payload))), 503)
})

test("custom checks run after otp-guard allows, and can deny", async () => {
  const denied = setup(allow(), async () => ({ status: 403, message: "Invite only" }))
  const response = await denied.handle(await signedRequest(payload))
  assert.equal(await outcome(response), 403)
  assert.equal((await response.json()).error.message, "Invite only")

  const broken = setup(allow(), async () => { throw new Error("boom") })
  assert.equal(await outcome(await broken.handle(await signedRequest(payload))), 503)

  let ran = false
  const refused = setup(refuse("ORIGIN_BLOCKED"), async () => { ran = true; return null })
  await refused.handle(await signedRequest(payload))
  assert.equal(ran, false)
})

test("rejects unsigned requests", async () => {
  const { handle, calls } = setup()
  assert.equal((await handle(new Request("https://x", { method: "POST", body: "{}" }))).status, 401)
  assert.equal(calls.length, 0)
})
