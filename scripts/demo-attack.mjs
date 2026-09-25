#!/usr/bin/env node
// Shows otp-guard stopping two attacks on a real project. Sends no SMS and costs nothing.
//
//   npm run demo:attack
//
// Needs SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (see .env.verify.example).
// Use a test project: the second attack counts toward that IP's signup limit.

const url = process.env.SUPABASE_URL?.replace(/\/$/, '')
const anonKey = process.env.SUPABASE_ANON_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !anonKey || !serviceKey) {
  console.error('Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (npm run demo:attack reads .env.verify).')
  process.exit(2)
}

const color = process.stdout.isTTY
  ? { bold: s => `\x1b[1m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m`, red: s => `\x1b[31m${s}\x1b[0m` }
  : { bold: s => s, dim: s => s, green: s => s, red: s => s }

async function sendsToday() {
  const response = await fetch(`${url}/rest/v1/rpc/otp_guard_status`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!response.ok) throw new Error(`otp_guard_status: HTTP ${response.status}. Is the migration applied?`)
  return (await response.json()).sends.day
}

async function message(response) {
  const body = await response.json().catch(() => ({}))
  return body.msg ?? body.message ?? JSON.stringify(body)
}

function report(blocked, by, text) {
  console.log(blocked ? `   ${color.green('✔')} Refused by ${by}: ${text}` : `   ${color.red('✖')} Not refused: ${text}`)
}

const before = await sendsToday()
console.log(color.bold('otp-guard demo · two attacks, no SMS') + '\n')

// 1. Through your app, to a destination you do not serve.
console.log(color.bold('1. Premium destination, through your app'))
console.log(color.dim('   +63 917 123 4567 (Philippines)'))
{
  const response = await fetch(`${url}/functions/v1/otp-gateway`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json', 'x-otp-guard-platform': 'mobile' },
    body: JSON.stringify({ method: 'POST', path: '/otp', query: {}, body: { phone: '+639171234567' } }),
  })
  report(!response.ok, 'the gateway', await message(response))
}

// 2. Skipping your app: straight to Supabase Auth, the way SMS pumping scripts do.
console.log('\n' + color.bold('2. Skip your app, call Supabase Auth directly'))
console.log(color.dim('   +52 55 0000 0001'))
{
  const response = await fetch(`${url}/auth/v1/otp`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '+525500000001', create_user: true }),
  })
  const text = await message(response)
  // Without a permit the Send SMS hook refuses. On a busy test IP the signup limit may
  // refuse first; both stop the message, but say which one did.
  report(!response.ok, text.includes('request a new code') ? 'the Send SMS hook' : 'otp-guard', text)
}

const sent = await sendsToday() - before
console.log('\n' + (sent === 0 ? color.green(`Messages sent: ${sent}`) : color.red(`Messages sent: ${sent}`)))
process.exit(sent === 0 ? 0 : 1)
