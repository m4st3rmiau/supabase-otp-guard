import { test } from "node:test"
import assert from "node:assert/strict"
import { createBirdProvider } from "../../supabase/functions/send-sms-hook/providers/bird.ts"

function capture(status = 202, headers: Record<string, string> = {}) {
  const calls: { url: string; body: Record<string, any> }[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
    return new Response(status >= 400 ? '{"error":{"type":"x","message":"nope"}}' : "{}", { status, headers })
  }) as typeof fetch
  return { calls, fetchImpl }
}

const env = (values: Record<string, string>) => (key: string) => ({ BIRD_API_KEY: "bk_us1_test", ...values })[key]

test("sms uses the built-in template unless a sender is registered", async () => {
  const template = capture()
  await createBirdProvider(env({}), template.fetchImpl).send("+525500000001", "123456")
  assert.equal(template.calls[0].url, "https://us1.platform.bird.com/v1/sms/messages")
  assert.deepEqual(template.calls[0].body.template.parameters, { code: "123456", ttl: "5" })

  const text = capture()
  await createBirdProvider(env({ BIRD_SMS_FROM: "Acme", BIRD_SMS_TEXT: "Code: {code}" }), text.fetchImpl)
    .send("+525500000001", "123456")
  assert.equal(text.calls[0].body.text, "Code: 123456")
  assert.equal(text.calls[0].body.template, undefined)
})

test("whatsapp puts the code in the body and the copy button", async () => {
  const { calls, fetchImpl } = capture()
  await createBirdProvider(env({ BIRD_CHANNEL: "whatsapp", BIRD_REGION: "eu1" }), fetchImpl).send("+525500000001", "9")
  assert.equal(calls[0].url, "https://eu1.platform.bird.com/v1/whatsapp/messages")
  assert.deepEqual(calls[0].body.template.components.map((c: any) => c.type), ["body", "button"])
})

test("errors and rate limits are reported, never thrown", async () => {
  const failed = await createBirdProvider(env({}), capture(500).fetchImpl).send("+525500000001", "1")
  assert.equal(failed.ok, false)
  const limited = await createBirdProvider(env({}), capture(429, { "retry-after": "7" }).fetchImpl).send("+525500000001", "1")
  assert.deepEqual([limited.ok, !limited.ok && limited.rateLimited, !limited.ok && limited.retryAfter], [false, true, "7"])
})

test("misconfiguration throws at construction", () => {
  assert.throws(() => createBirdProvider(() => undefined, fetch), /BIRD_API_KEY/)
  assert.throws(() => createBirdProvider(env({ BIRD_CHANNEL: "fax" }), fetch), /BIRD_CHANNEL/)
})
