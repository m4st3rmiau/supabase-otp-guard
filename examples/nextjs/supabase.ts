// Browser client for a Next.js app. Server-side clients do not send OTPs from the
// user's browser, so they do not need the gateway.
import { createBrowserClient } from "@supabase/ssr"
import { browserDeviceId, createOtpGuardFetch, otpGuardReason } from "@otp-guard/client"

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createBrowserClient(url, anonKey, {
  global: {
    fetch: createOtpGuardFetch({ supabaseUrl: url, platform: "web", getDeviceId: browserDeviceId() }),
  },
})

// `captchaToken` comes from a Cloudflare Turnstile widget rendered on the form. Ask for
// a fresh token for every send: tokens are single use.
export async function sendCode(phone: string, captchaToken: string) {
  const { error } = await supabase.auth.signInWithOtp({ phone, options: { captchaToken } })
  if (!error) return { ok: true as const }
  switch (otpGuardReason(error)) {
    case "DEVICE_PENDING_VERIFICATION":
      return { ok: false as const, message: "Verify one of the numbers you already received a code on." }
    case "DESTINATION_NOT_ALLOWED":
      return { ok: false as const, message: "We only support numbers from Mexico for now." }
    default:
      return { ok: false as const, message: error.message }
  }
}
