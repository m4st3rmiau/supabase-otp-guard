import { test } from "node:test"
import assert from "node:assert/strict"
import { redact } from "../../supabase/functions/_shared/otp-guard/log.ts"

test("provider errors stay readable, secrets and contacts do not", () => {
  const message = "This destination requires a registered sender before sending. See the Bird docs for details."
  const out = redact({
    birdMessage: message,
    authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
    phone: "+525512345678",
    nested: { email: "person@example.com", note: "+525512345678" },
    otp: "123456",
  }) as Record<string, any>
  assert.equal(out.birdMessage, message)
  assert.equal(out.authorization, "Bear...ture")
  assert.equal(out.phone, "***5678")
  assert.equal(out.nested.email, "pe***@example.com")
  assert.equal(out.nested.note, "***5678", "phones are masked even under harmless keys")
  assert.equal(out.otp, "[redacted]")
})
