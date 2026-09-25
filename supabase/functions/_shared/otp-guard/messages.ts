// User-facing text for every rejection. This is a template: translate or reword freely.
// Apps that want their own copy can map `error_code` (otp_guard_<reason>) instead.

export type Rejection = { status: number; message: string }

const TRY_LATER = "We couldn't send the code. Please try again later."
const TOO_MANY = "Too many attempts. Please try again later."
const NUMBER_UNAVAILABLE = "This number can't receive verification codes."
const CONTACT_SUPPORT = "We can't send a code right now. Contact support if you need help."
const INVALID_REQUEST = "Invalid request."

export function rejection(reason: string | null): Rejection {
  switch (reason) {
    case "INVALID_PHONE":
      return { status: 400, message: "Enter a valid phone number." }
    case "INVALID_REQUEST":
    case "INVALID_PLATFORM":
      return { status: 400, message: INVALID_REQUEST }
    case "INVALID_ORIGIN":
    case "MOBILE_DISABLED":
    case "CAPTCHA_FAILED":
      return { status: 403, message: "We couldn't verify this request. Please try again." }
    case "DESTINATION_NOT_ALLOWED":
    case "BLOCKLISTED":
      return { status: 400, message: NUMBER_UNAVAILABLE }
    case "ORIGIN_BLOCKED":
    case "DEVICE_BLOCKED":
      return { status: 403, message: CONTACT_SUPPORT }
    case "SEND_PERMIT_REQUIRED":
      return { status: 403, message: "Please request a new code from the app." }
    case "DEVICE_PENDING_VERIFICATION":
      return {
        status: 429,
        message: "We already sent codes to other numbers from this device. Verify one of them or try again tomorrow.",
      }
    case "ORIGIN_UNAVAILABLE":
    case "UNAVAILABLE":
    case "PROVIDER_ERROR":
      return { status: 503, message: TRY_LATER }
    default:
      return { status: 429, message: TOO_MANY }
  }
}
