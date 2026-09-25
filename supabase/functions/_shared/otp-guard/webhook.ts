// Standard Webhooks verification for Supabase Auth hooks. Auth signs hook requests with
// a symmetric secret instead of a JWT, so hook functions are deployed without JWT
// verification and check the signature here.

const TOLERANCE_SECONDS = 300

export type WebhookCheck =
  | { ok: true }
  | { ok: false; reason: "missing_headers" | "stale_timestamp" | "bad_signature" }

function constantTimeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

function decodeBase64(value: string) {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0))
}

/**
 * Verifies webhook-id / webhook-timestamp / webhook-signature against the raw body.
 * `secret` is the value shown when enabling the hook, in "v1,whsec_<base64>" form.
 */
export async function verifyAuthHook(req: Request, body: string, secret: string): Promise<WebhookCheck> {
  const id = req.headers.get("webhook-id")
  const timestamp = req.headers.get("webhook-timestamp")
  const signatureHeader = req.headers.get("webhook-signature")
  if (!id || !timestamp || !signatureHeader) return { ok: false, reason: "missing_headers" }

  // A captured request cannot be replayed later.
  const seconds = Number(timestamp)
  if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > TOLERANCE_SECONDS) {
    return { ok: false, reason: "stale_timestamp" }
  }

  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey(
      "raw",
      decodeBase64(secret.replace(/^v1,\s*/, "").replace(/^whsec_/, "")),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
  } catch {
    return { ok: false, reason: "bad_signature" }
  }

  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
  )
  // The header may carry several space-separated versioned signatures.
  const matches = signatureHeader.split(" ").some(entry => {
    const [version, value] = entry.split(",")
    if (version !== "v1" || !value) return false
    try {
      return constantTimeEqual(expected, decodeBase64(value))
    } catch {
      return false
    }
  })
  return matches ? { ok: true } : { ok: false, reason: "bad_signature" }
}
