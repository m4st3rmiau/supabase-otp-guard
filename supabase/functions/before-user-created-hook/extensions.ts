// Your own signup rules, run after otp-guard allowed the origin. This is a template:
// replace the body with your checks (banned numbers, invite-only domains, ...).
//
// Return null to allow, or { status, message } to deny. Throwing denies with a 503.

export type SignupUser = { id?: string; phone?: string | null; email?: string | null }
export type SignupDenial = { status: number; message: string }

export function customSignupCheck(_user: SignupUser): Promise<SignupDenial | null> {
  return Promise.resolve(null)
}
