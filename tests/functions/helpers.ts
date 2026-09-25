import type { Logger, Rpc } from "../../supabase/functions/_shared/otp-guard/types.ts"

export const HOOK_SECRET = `v1,whsec_${Buffer.from("otp-guard-test-secret-32-bytes!!").toString("base64")}`

/** Builds a request signed exactly like Supabase Auth signs hook calls. */
export async function signedRequest(payload: unknown, { secret = HOOK_SECRET, age = 0 } = {}) {
  const body = JSON.stringify(payload)
  const id = `msg_${Math.random().toString(36).slice(2)}`
  const timestamp = String(Math.floor(Date.now() / 1000) - age)
  const key = await crypto.subtle.importKey("raw",
    Buffer.from(secret.replace(/^v1,/, "").replace(/^whsec_/, ""), "base64"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const signature = Buffer.from(await crypto.subtle.sign("HMAC", key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`))).toString("base64")
  return new Request("https://example.invalid/hook", {
    method: "POST",
    headers: { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` },
    body,
  })
}

export function recordingRpc(responses: Record<string, unknown | (() => unknown)>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = []
  const rpc: Rpc = async (fn, args) => {
    calls.push({ fn, args })
    const response = responses[fn]
    if (response instanceof Error) throw response
    return { data: typeof response === "function" ? response() : response ?? null, error: null }
  }
  return { rpc, calls }
}

export function silentLog(): Logger & { warnings: string[]; errors: string[] } {
  const warnings: string[] = []
  const errors: string[] = []
  return {
    warnings, errors,
    info() {},
    warn(message) { warnings.push(message) },
    error(message) { errors.push(message) },
  }
}

export const allow = (extra: Record<string, unknown> = {}) => ({ allowed: true, reason: null, retry_after: 0, ...extra })
export const refuse = (reason: string, retry = 0) => ({ allowed: false, reason, retry_after: retry })

/**
 * The status the client will see from a hook response. Auth only relays errors sent as
 * 200 with `error.http_code`, so a signed hook error must never use another status.
 */
export async function outcome(response: Response): Promise<number> {
  const body = await response.clone().json().catch(() => null) as { error?: { http_code?: number } } | null
  if (!body?.error) return response.status
  if (response.status !== 200) throw new Error(`hook error sent with HTTP ${response.status}; Auth would not relay it`)
  return body.error.http_code ?? 500
}
