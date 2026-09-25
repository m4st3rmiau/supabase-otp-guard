#!/usr/bin/env node
// Checks that a deployed project matches what otp-guard assumes. Sends no SMS.
//
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
//   [SUPABASE_ACCESS_TOKEN=...]   # optional, enables the Auth config checks
//   node scripts/verify.mjs
//
// The IP check needs OTP_GUARD_DIAGNOSTICS=true on the otp-gateway function while it
// runs. Turn it off afterwards.

const url = process.env.SUPABASE_URL?.replace(/\/$/, '')
const anonKey = process.env.SUPABASE_ANON_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const accessToken = process.env.SUPABASE_ACCESS_TOKEN
if (!url || !anonKey || !serviceKey) {
  console.error('Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(2)
}

let failures = 0
let warnings = 0
const pass = message => console.log(`PASS  ${message}`)
const fail = message => { failures++; console.log(`FAIL  ${message}`) }
const warn = message => { warnings++; console.log(`WARN  ${message}`) }

async function rpc(fn, key, args = {}) {
  const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

// 1. The migration is applied and configured.
const status = await rpc('otp_guard_status', serviceKey)
if (status.status !== 200 || !status.body?.version) {
  fail(`otp_guard_status is not callable with the service role (HTTP ${status.status}). Is the migration applied?`)
} else {
  pass(`migration ${status.body.version} applied`)
  if (status.body.missing_settings.length) fail(`missing settings: ${status.body.missing_settings.join(', ')}`)
  else pass('all settings present')
  if (status.body.allowed_destinations === 0) fail('otp_guard.allowed_destinations is empty: every phone is refused')
  else pass(`${status.body.allowed_destinations} allowed destination prefix(es)`)
}

// 2. API roles cannot reach the entry points.
const anonCall = await rpc('otp_guard_create_permit', anonKey,
  { p_phone: '+10000000000', p_ip: '192.0.2.1', p_device_id: null, p_client_platform: 'web' })
// 404 means the function does not exist yet, which proves nothing about privileges.
if (anonCall.status === 404) warn('privilege check skipped: otp_guard_create_permit not found (migration not applied?)')
else if (anonCall.status === 200) fail('anon can call otp_guard_create_permit: re-run the privileges block of the migration')
else pass(`anon cannot call otp_guard_create_permit (HTTP ${anonCall.status})`)

// 3. X-Forwarded-For cannot be forged through Supabase's edge.
async function probe(forged) {
  const response = await fetch(`${url}/functions/v1/otp-gateway`, {
    method: 'POST',
    headers: { apikey: anonKey, 'x-otp-guard-diagnose': 'ip', 'x-forwarded-for': forged, 'Content-Type': 'application/json' },
    body: '{}',
  })
  const body = await response.json().catch(() => null)
  return typeof body?.ip === 'string' ? body.ip : null
}
const first = await probe('203.0.113.10')
const second = await probe('203.0.113.20')
if (first === null || second === null) {
  warn('IP check skipped: deploy otp-gateway and set OTP_GUARD_DIAGNOSTICS=true while running this script')
} else if (first === '203.0.113.10' || second === '203.0.113.20') {
  fail('a client-supplied X-Forwarded-For reached the gateway. Every IP-based limit is bypassable. Do not deploy.')
} else if (first !== second) {
  warn(`the gateway saw two different IPs for one client (${first}, ${second}); check for a proxy in front of Supabase`)
} else {
  pass(`the gateway sees the connecting IP (${first}), not the forged header`)
  warn('remember to unset OTP_GUARD_DIAGNOSTICS on otp-gateway')
}

// 4. Auth configuration, through the Management API.
if (!accessToken) {
  warn('Auth config checks skipped: set SUPABASE_ACCESS_TOKEN to enable them')
} else {
  const ref = new URL(url).hostname.split('.')[0]
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const config = await response.json().catch(() => null)
  if (!response.ok || !config) {
    warn(`could not read the Auth config (HTTP ${response.status})`)
  } else {
    const check = (field, expected, message) => {
      if (!(field in config)) warn(`${field} not returned by the Management API; check it in the dashboard`)
      else if (expected(config[field])) pass(message)
      else fail(`${message} (got ${JSON.stringify(config[field])})`)
    }
    check('external_phone_enabled', v => v === true, 'phone provider enabled (Auth refuses phone OTP otherwise)')
    check('hook_send_sms_enabled', v => v === true, 'Send SMS hook enabled')
    check('hook_send_sms_uri', v => typeof v === 'string' && v.includes('send-sms-hook'), 'Send SMS hook points to send-sms-hook')
    check('hook_before_user_created_enabled', v => v === true, 'Before User Created hook enabled')
    // The gateway verifies Turnstile itself. Project captcha would verify the same
    // single-use token a second time and fail every web login.
    check('security_captcha_enabled', v => v !== true, 'project-level captcha is off')
  }
}

console.log(`\n${failures} failure(s), ${warnings} warning(s)`)
process.exit(failures ? 1 : 0)
