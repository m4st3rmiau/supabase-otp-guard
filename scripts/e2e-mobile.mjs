#!/usr/bin/env node
// End-to-end check of the mobile path against a real project. Sends ONE real code.
//
//   node --env-file=.env.verify scripts/e2e-mobile.mjs +525512345678
//
// 1. A foreign number is refused by the gateway (free: no SMS, no account).
// 2. The gateway issues a permit, Auth generates a code, the hook delivers it via the
//    provider. You type the code; Auth verifies it. If the provider does not deliver,
//    otp-guard's part is still checked and the provider is reported as a warning.
// 3. After Auth's own 60-second resend window, a direct call to /auth/v1/otp that skips
//    the gateway is refused by the hook: no permit, no send.
// Uses a test project only. Needs SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
import { createInterface } from 'node:readline/promises'
import { randomUUID } from 'node:crypto'

const url = process.env.SUPABASE_URL?.replace(/\/$/, '')
const anonKey = process.env.SUPABASE_ANON_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const phone = process.argv[2]
if (!url || !anonKey || !serviceKey || !/^\+[1-9]\d{7,14}$/.test(phone ?? '')) {
  console.error('Usage: node --env-file=.env.verify scripts/e2e-mobile.mjs +525512345678')
  process.exit(2)
}

let failures = 0
let warnings = 0
const pass = message => console.log(`PASS  ${message}`)
const fail = message => { failures++; console.log(`FAIL  ${message}`) }
const info = message => console.log(`      ${message}`)
const device = randomUUID()

async function json(response) {
  const text = await response.text()
  try { return JSON.parse(text) } catch { return { raw: text } }
}

async function sends() {
  const response = await fetch(`${url}/rest/v1/rpc/otp_guard_status`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: '{}',
  })
  const body = await json(response)
  if (!response.ok) throw new Error(`otp_guard_status failed: HTTP ${response.status}`)
  return body.sends.day
}

// What createOtpGuardFetch sends for supabase.auth.signInWithOtp({ phone }) on mobile.
function viaGateway(to) {
  return fetch(`${url}/functions/v1/otp-gateway`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json',
      'x-otp-guard-platform': 'mobile', 'x-otp-guard-device': device },
    body: JSON.stringify({ method: 'POST', path: '/otp', query: {}, body: { phone: to, create_user: true } }),
  })
}

// --- 1. Destination rules, before anything is paid for ---------------------------------
{
  const before = await sends()
  const response = await viaGateway('+639171234567')
  const body = await json(response)
  if (response.status === 400 && body.error_code === 'otp_guard_destination_not_allowed' && await sends() === before) {
    pass('foreign number refused by the gateway, nothing sent')
  } else {
    fail(`foreign number: expected 400 otp_guard_destination_not_allowed, got ${response.status} ${JSON.stringify(body)}`)
  }
}

// --- 2. Real send through the gateway, then verify ---------------------------------------
// If the provider does not deliver (no balance, unapproved template...), otp-guard's part
// can still be proven: the permit was used and exactly one send was reserved. The script
// reports the provider as a warning and carries on to the side-door test.
let delivered = false
{
  const before = await sends()
  const response = await viaGateway(phone)
  const body = await json(response)
  const after = await sends()
  if (after !== before + 1) {
    fail(`expected otp-guard to authorize exactly one send, went from ${before} to ${after} (HTTP ${response.status} ${JSON.stringify(body)})`)
    info('Check the send-sms-hook and otp-gateway logs in the dashboard.')
    process.exit(1)
  }
  pass('gateway -> Auth -> hook: permit used, one send authorized')

  if (!response.ok) {
    warnings++
    console.log(`WARN  the provider did not deliver: ${body.msg ?? JSON.stringify(body)}`)
    info('otp-guard did its part; the reason is in the send-sms-hook log "provider rejected the message".')
    info('Skipping code verification.')
  } else {
    delivered = true
    pass('provider accepted the message')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const code = (await rl.question(`      Code received on ${phone}: `)).trim()
    rl.close()
    const verify = await fetch(`${url}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'sms', phone, token: code }),
    })
    const session = await json(verify)
    if (verify.ok && session.access_token) pass('code verified by Auth, session issued')
    else fail(`verify: HTTP ${verify.status} ${JSON.stringify(session)}`)
  }
}

// --- 3. Skipping the gateway gets nothing --------------------------------------------------
{
  if (delivered) {
    // Auth refuses a second code to the same phone within 60 s on its own, before calling
    // the hook. Waiting past it makes sure the refusal below comes from otp-guard.
    for (let left = 65; left > 0; left -= 5) {
      process.stdout.write(`\r      Waiting ${left}s for Auth's resend window...  `)
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
    process.stdout.write('\r' + ' '.repeat(50) + '\r')
  }

  const before = await sends()
  const direct = await fetch(`${url}/auth/v1/otp`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    // After a delivered code the account exists: create_user false, so no junk account can
    // be created. If delivery failed, Auth rolled the new account back, so the call must
    // be allowed to create it again, or Auth would refuse before ever reaching the hook.
    body: JSON.stringify({ phone, create_user: !delivered }),
  })
  const body = await json(direct)
  const after = await sends()
  const said = body.msg ?? body.message ?? body.error_description ?? JSON.stringify(body)
  if (!direct.ok && after === before) {
    pass(`direct /auth/v1/otp refused (HTTP ${direct.status}), nothing sent`)
    info(`Auth said: ${said}`)
  } else {
    fail(`direct /auth/v1/otp: HTTP ${direct.status}, sends ${before} -> ${after}. The side door is open.`)
  }
}

console.log(`\n${failures} failure(s), ${warnings} warning(s)`)
process.exit(failures ? 1 : 0)
