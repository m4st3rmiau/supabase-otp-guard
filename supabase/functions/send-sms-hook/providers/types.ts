export type DeliveryResult =
  | { ok: true; requestId?: string | null }
  | { ok: false; rateLimited: boolean; retryAfter?: string | null; detail?: Record<string, unknown> }

/**
 * A message provider. It only delivers: Supabase Auth generates and verifies the code,
 * and otp-guard has already authorized this send when `send` is called.
 */
export interface OtpProvider {
  readonly name: string
  send(phone: string, otp: string): Promise<DeliveryResult>
}
