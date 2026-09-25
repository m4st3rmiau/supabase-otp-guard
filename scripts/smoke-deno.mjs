#!/usr/bin/env node
// Boots each Edge Function in real Deno with an unreachable database and checks that it
// verifies signatures and fails closed. Needs `deno` on PATH (or DENO=/path/to/deno).
//   node scripts/smoke-deno.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const DENO = process.env.DENO ?? 'deno'
const PORT = 8000 // Deno.serve's default: the entrypoints do not pick a port.
const SECRET = `v1,whsec_${Buffer.from('otp-guard-smoke-secret-32-bytes!').toString('base64')}`
const ENV = {
  SUPABASE_URL: 'http://127.0.0.1:9', // nothing listens here
  SUPABASE_SERVICE_ROLE_KEY: 'smoke', SUPABASE_ANON_KEY: 'smoke', BIRD_API_KEY: 'bk_smoke',
  SEND_SMS_HOOK_SECRET: SECRET, BEFORE_USER_CREATED_HOOK_SECRET: SECRET,
}

async function signed(payload) {
  const body = JSON.stringify(payload)
  const id = 'msg_smoke'
  const timestamp = String(Math.floor(Date.now() / 1000))
  const key = await crypto.subtle.importKey('raw', Buffer.from(SECRET.slice(9), 'base64'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = Buffer.from(await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`))).toString('base64')
  return { method: 'POST', body,
    headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` } }
}

// Auth hooks report errors as HTTP 200 with error.http_code (the only form Auth relays).
async function hookStatus(response) {
  const body = await response.json().catch(() => null)
  if (!body?.error) return response.status
  assert.equal(response.status, 200, 'hook errors must be sent as HTTP 200')
  return body.error.http_code
}

async function withFunction(name, check) {
  const child = spawn(DENO, ['run', '--no-config', '--allow-net', '--allow-env', `supabase/functions/${name}/index.ts`],
    { env: { ...process.env, ...ENV }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  try {
    for (let i = 0; !output.includes('Listening'); i++) {
      if (i > 240 || child.exitCode !== null) throw new Error(`${name} did not start:\n${output}`)
      await sleep(250)
    }
    await check((init) => fetch(`http://127.0.0.1:${PORT}`, init))
    console.log(`PASS ${name}`)
  } finally {
    child.kill()
    await new Promise(resolve => child.once('exit', resolve))
  }
}

const smsPayload = { user: { id: '11111111-1111-4111-8111-111111111111', phone: '525500000001' },
  sms: { otp: '123456', phone: '525500000001' } }

await withFunction('send-sms-hook', async call => {
  assert.equal((await call({ method: 'POST', body: JSON.stringify(smsPayload) })).status, 401, 'unsigned')
  assert.equal(await hookStatus(await call(await signed(smsPayload))), 503, 'no database: provider never contacted')
})

await withFunction('before-user-created-hook', async call => {
  assert.equal((await call({ method: 'POST', body: '{}' })).status, 401, 'unsigned')
  assert.equal(await hookStatus(await call(await signed({ metadata: { ip_address: '203.0.113.1' }, user: { email: 'a@example.com' } }))),
    503, 'no database: signup refused')
})

await withFunction('otp-gateway', async call => {
  const request = { method: 'POST', path: '/otp', body: { phone: '+525500000001' } }
  const headers = { 'x-otp-guard-platform': 'mobile', 'Content-Type': 'application/json' }
  assert.equal((await call({ method: 'POST', headers, body: JSON.stringify(request) })).status, 503,
    'no database: Auth never contacted')
  assert.equal((await call({ method: 'POST', headers: { ...headers, 'x-otp-guard-platform': 'web' },
    body: JSON.stringify(request) })).status, 403, 'web without an allowed Origin')
})
