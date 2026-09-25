import type { Logger } from "./types.ts"

// Keys whose values are masked even inside nested objects. Phones, codes and secrets
// must never reach the function logs in clear.
const SENSITIVE_KEY = /(authorization|apikey|api_key|token|secret|password|otp|code|phone|email|metadata|payload|body)$/i

// Emails and phone numbers are masked wherever they appear. Secrets are masked by key
// (SENSITIVE_KEY). Other text stays readable, so provider error messages reach the logs.
function mask(value: string) {
  const trimmed = value.trim()
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    const [local, domain] = trimmed.split("@")
    return `${local.slice(0, 2)}***@${domain}`
  }
  if (/^\+?\d{7,}$/.test(trimmed)) return `***${trimmed.slice(-4)}`
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed
}

function maskSecret(value: string) {
  const trimmed = value.trim()
  return trimmed.length > 16 ? `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}` : "[redacted]"
}

export function redact(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "string") return mask(value)
  if (value instanceof Error) return { name: value.name, message: mask(value.message) }
  if (depth >= 4) return "[redacted-depth]"
  if (Array.isArray(value)) return value.slice(0, 20).map(item => redact(item, depth + 1))
  if (typeof value === "object") {
    const output: Record<string, unknown> = {}
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (!SENSITIVE_KEY.test(key)) output[key] = redact(raw, depth + 1)
      else if (typeof raw !== "string") output[key] = "[redacted]"
      else output[key] = /phone|email/i.test(key) ? mask(raw) : maskSecret(raw)
    }
    return output
  }
  return String(value)
}

export function createLogger(scope: string): Logger {
  const write = (fn: (...args: unknown[]) => void) => (message: string, data?: unknown) =>
    data === undefined ? fn(`${scope}: ${message}`) : fn(`${scope}: ${message}`, redact(data))
  return {
    info: write(console.log),
    warn: write(console.warn),
    error: write(console.error),
  }
}
