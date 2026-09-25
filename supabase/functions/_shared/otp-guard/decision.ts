import type { Decision, Rpc } from "./types.ts"

/**
 * Validates what an otp_guard_* function returned. Anything unexpected is treated as a
 * failure: a half-applied migration must not open sending.
 */
export function parseDecision(data: unknown): Decision | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  const record = data as Record<string, unknown>
  if (typeof record.allowed !== "boolean") return null
  const retryAfter = record.retry_after
  if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter) || retryAfter < 0) return null
  if (record.allowed ? record.reason !== null : typeof record.reason !== "string") return null
  return {
    allowed: record.allowed,
    reason: record.reason as string | null,
    retryAfter,
    data: record,
  }
}

/** Runs an otp_guard_* function. Returns null on any error so callers fail closed. */
export async function decide(rpc: Rpc, fn: string, args: Record<string, unknown>): Promise<Decision | null> {
  try {
    const { data, error } = await rpc(fn, args)
    if (error) return null
    return parseDecision(data)
  } catch {
    return null
  }
}
