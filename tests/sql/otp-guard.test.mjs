import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { startDatabase, reset, phone, device, freshIp, createPermit, authorizeSend, deliver, age } from './harness.mjs'

let db
before(async () => { db = await startDatabase(55441) })
after(async () => { await db?.stop() })
beforeEach(async () => { await reset(db.pool) })

const q = (sql, params) => db.pool.query(sql, params)
const scalar = async (sql, params) => Object.values((await q(sql, params)).rows[0])[0]

test('no permit, no send', async () => {
  const decision = await authorizeSend(db.pool, { to: phone(1) })
  assert.deepEqual(decision, { allowed: false, reason: 'SEND_PERMIT_REQUIRED', retry_after: 0 })
  assert.equal(await scalar('SELECT count(*)::int FROM otp_guard.sends'), 0)
})

test('a permit is single use', async () => {
  const permit = await createPermit(db.pool, { to: phone(1) })
  assert.equal(permit.allowed, true)
  assert.equal(permit.phone, phone(1))
  assert.equal((await authorizeSend(db.pool, { to: phone(1) })).allowed, true)
  assert.equal((await authorizeSend(db.pool, { to: phone(1) })).reason, 'SEND_PERMIT_REQUIRED')
})

test('the hook matches Auth phone formats without "+"', async () => {
  await createPermit(db.pool, { to: phone(1) })
  assert.equal((await authorizeSend(db.pool, { to: phone(1).slice(1) })).allowed, true)
})

test('expired and revoked permits cannot be consumed', async () => {
  await createPermit(db.pool, { to: phone(1) })
  await age(db.pool, '61 seconds')
  assert.equal((await authorizeSend(db.pool, { to: phone(1) })).reason, 'SEND_PERMIT_REQUIRED')

  const permit = await createPermit(db.pool, { to: phone(2) })
  await q('SELECT public.otp_guard_revoke_permit($1)', [permit.permit_id])
  assert.equal((await authorizeSend(db.pool, { to: phone(2) })).reason, 'SEND_PERMIT_REQUIRED')
})

test('revoked permits still count toward origin limits', async () => {
  const ip = '203.0.113.5'
  for (let i = 1; i <= 3; i++) {
    const permit = await createPermit(db.pool, { to: phone(1), ip })
    await q('SELECT public.otp_guard_revoke_permit($1)', [permit.permit_id])
  }
  assert.equal((await createPermit(db.pool, { to: phone(1), ip })).reason, 'ORIGIN_MINUTE_LIMIT')
})

test('destinations outside the allowlist never get a permit', async () => {
  const decision = await createPermit(db.pool, { to: '+639171234567' })
  assert.equal(decision.reason, 'DESTINATION_NOT_ALLOWED')
  assert.equal((await createPermit(db.pool, { to: '+52551234567' })).reason, 'DESTINATION_NOT_ALLOWED',
    'wrong national length for the allowed prefix')
  assert.equal(await scalar('SELECT count(*)::int FROM otp_guard.permits'), 0)
})

test('an empty allowlist refuses everything', async () => {
  await q('TRUNCATE otp_guard.allowed_destinations')
  assert.equal((await createPermit(db.pool, { to: phone(1) })).reason, 'DESTINATION_NOT_ALLOWED')
})

test('blocked prefixes win inside an allowed country', async () => {
  await q("INSERT INTO otp_guard.blocked_prefixes (prefix, reason) VALUES ('+525500', 'test range')")
  assert.equal((await createPermit(db.pool, { to: phone(1) })).reason, 'BLOCKLISTED')
})

test('the gateway must supply a valid IP and platform', async () => {
  assert.equal((await createPermit(db.pool, { to: phone(1), ip: '' })).reason, 'ORIGIN_UNAVAILABLE')
  assert.equal((await createPermit(db.pool, { to: phone(1), ip: '10.0.0.0/8' })).reason, 'ORIGIN_UNAVAILABLE')
  assert.equal((await createPermit(db.pool, { to: phone(1), platform: 'desktop' })).reason, 'INVALID_PLATFORM')
  assert.equal((await createPermit(db.pool, { to: 'not a phone' })).reason, 'INVALID_PHONE')
})

test('origin limits group IPv6 by /64', async () => {
  for (let i = 1; i <= 3; i++) {
    assert.equal((await createPermit(db.pool, { to: phone(1), ip: `2001:db8:1:2::${i}` })).allowed, true)
  }
  assert.equal((await createPermit(db.pool, { to: phone(1), ip: '2001:db8:1:2::99' })).reason, 'ORIGIN_MINUTE_LIMIT')
  assert.equal((await createPermit(db.pool, { to: phone(1), ip: '2001:db8:1:3::1' })).allowed, true)
})

test('an origin rotating destinations is refused a new one, not a known one', async () => {
  const ip = '203.0.113.9'
  for (let i = 1; i <= 3; i++) {
    assert.equal((await createPermit(db.pool, { to: phone(i), ip })).allowed, true)
    await age(db.pool, '2 minutes')
  }
  assert.equal((await createPermit(db.pool, { to: phone(4), ip })).reason, 'ORIGIN_DESTINATION_SHORT_LIMIT')
  assert.equal((await createPermit(db.pool, { to: phone(1), ip })).allowed, true)
})

test('a third unverified number from one device is refused; a resend is not', async () => {
  const deviceId = device(1)
  assert.equal((await deliver(db.pool, { to: phone(1), deviceId })).allowed, true)
  assert.equal((await deliver(db.pool, { to: phone(2), deviceId })).allowed, true, 'a typo then the right number')
  assert.equal((await deliver(db.pool, { to: phone(3), deviceId })).reason, 'DEVICE_PENDING_VERIFICATION')
  assert.equal((await deliver(db.pool, { to: phone(2), deviceId })).allowed, true, 'resend to a pending number')
})

test('verified numbers are not pending, and logging in to one is always allowed', async () => {
  const deviceId = device(1)
  await deliver(db.pool, { to: phone(1), deviceId })
  await deliver(db.pool, { to: phone(2), deviceId })
  await q("INSERT INTO auth.users (phone, phone_confirmed_at) VALUES ($1, now())", [phone(9).slice(1)])
  assert.equal((await deliver(db.pool, { to: phone(9), deviceId })).allowed, true, 'already verified number')
  await q("INSERT INTO auth.users (phone, phone_confirmed_at) VALUES ($1, now())", [phone(1).slice(1)])
  assert.equal((await deliver(db.pool, { to: phone(3), deviceId })).allowed, true, 'one pending slot freed')
})

test('pending numbers survive permit retention', async () => {
  const deviceId = device(1)
  await deliver(db.pool, { to: phone(1), deviceId })
  await deliver(db.pool, { to: phone(2), deviceId })
  await q("TRUNCATE otp_guard.permits, otp_guard.sends")
  await q("UPDATE otp_guard.device_phones SET last_seen_at = now() - interval '15 days'")
  assert.equal((await createPermit(db.pool, { to: phone(3), deviceId })).reason, 'DEVICE_PENDING_VERIFICATION')
  await q("UPDATE otp_guard.device_phones SET last_seen_at = now() - interval '91 days'")
  assert.equal((await createPermit(db.pool, { to: phone(3), deviceId })).allowed, true, 'outside the lookback')
})

test('rotating past the pending limit blocks the device', async () => {
  const deviceId = device(1)
  await deliver(db.pool, { to: phone(1), deviceId })
  await deliver(db.pool, { to: phone(2), deviceId })
  assert.equal((await deliver(db.pool, { to: phone(3), deviceId })).reason, 'DEVICE_PENDING_VERIFICATION')
  assert.equal((await deliver(db.pool, { to: phone(4), deviceId })).reason, 'DEVICE_PENDING_VERIFICATION')
  assert.equal((await deliver(db.pool, { to: phone(5), deviceId })).reason, 'DEVICE_BLOCKED')
  assert.equal((await deliver(db.pool, { to: phone(1), deviceId })).reason, 'DEVICE_BLOCKED')
  const subject = (await q(`SELECT risk_level, status, reason FROM otp_guard.risk_subjects
    WHERE subject_type = 'device'`)).rows[0]
  assert.deepEqual(subject, { risk_level: 'high_risk', status: 'blocked', reason: 'unverified_destination_rotation' })
})

test('phone limits hold across permits', async () => {
  await createPermit(db.pool, { to: phone(1) })
  assert.equal((await authorizeSend(db.pool, { to: phone(1) })).allowed, true)
  await createPermit(db.pool, { to: phone(1) })
  const second = await authorizeSend(db.pool, { to: phone(1) })
  assert.equal(second.reason, 'PHONE_MINUTE_LIMIT')
  assert.ok(second.retry_after > 0 && second.retry_after <= 60)
})

test('an account cannot fan out to many destinations', async () => {
  const userId = '11111111-1111-4111-8111-111111111111'
  for (let i = 1; i <= 3; i++) assert.equal((await deliver(db.pool, { to: phone(i), userId })).allowed, true)
  assert.equal((await deliver(db.pool, { to: phone(4), userId })).reason, 'ACCOUNT_DESTINATION_LIMIT')
  assert.equal((await deliver(db.pool, { to: phone(2), userId })).allowed, true)
})

test('the global ceiling caps spend and is not abuse evidence', async () => {
  await q("UPDATE otp_guard.settings SET value = 2 WHERE key = 'global.sends_per_minute'")
  for (let i = 1; i <= 2; i++) {
    await createPermit(db.pool, { to: phone(i) })
    assert.equal((await authorizeSend(db.pool, { to: phone(i) })).allowed, true)
  }
  await createPermit(db.pool, { to: phone(3) })
  assert.equal((await authorizeSend(db.pool, { to: phone(3) })).reason, 'GLOBAL_MINUTE_LIMIT')
  assert.equal(await scalar('SELECT count(*)::int FROM otp_guard.risk_events WHERE abuse_signal'), 0)
})

test('near_limit reports usage before the ceiling is hit', async () => {
  await q("UPDATE otp_guard.settings SET value = 5 WHERE key = 'global.sends_per_minute'")
  const results = []
  for (let i = 1; i <= 4; i++) {
    await createPermit(db.pool, { to: phone(i) })
    results.push(await authorizeSend(db.pool, { to: phone(i) }))
  }
  assert.deepEqual(results.map(r => r.near_limit), [false, false, false, true])
  assert.equal(results[3].usage.minute, 4)
})

test('a missing setting fails closed', async () => {
  await q("DELETE FROM otp_guard.settings WHERE key = 'origin.permits_per_minute'")
  await assert.rejects(createPermit(db.pool, { to: phone(1) }), /setting "origin.permits_per_minute" is missing/)
  const status = await scalar('SELECT public.otp_guard_status()')
  assert.deepEqual(status.missing_settings, ['origin.permits_per_minute'])
})

test('20 rejections across 8 targets block an IP, volume alone does not', async () => {
  const ip = '203.0.113.50'
  for (let n = 0; n < 25; n++) await createPermit(db.pool, { to: '+639170000001', ip })
  assert.equal(await scalar(`SELECT count(*)::int FROM otp_guard.origin_blocks`), 0,
    'shared addresses (carrier NAT) are not blocked on volume alone')

  const other = '203.0.113.51'
  let last
  for (let n = 0; n < 20; n++) last = await createPermit(db.pool, { to: `+63917000${String(n % 8).padStart(4, '0')}`, ip: other })
  assert.equal(last.reason, 'ORIGIN_BLOCKED')
  assert.equal(await scalar(`SELECT count(*)::int FROM otp_guard.origin_blocks WHERE network = '203.0.113.51/32'`), 1)
})

test('20 rejections block a device even for one target', async () => {
  const deviceId = device(7)
  let last
  for (let n = 0; n < 20; n++) last = await createPermit(db.pool, { to: '+639170000001', deviceId })
  assert.equal(last.reason, 'DEVICE_BLOCKED')
})

test('risk events store hashes, never phones', async () => {
  await createPermit(db.pool, { to: '+639171234567' })
  const row = (await q('SELECT target_hash FROM otp_guard.risk_events')).rows[0]
  assert.match(row.target_hash, /^[0-9a-f]{64}$/)
  const dump = JSON.stringify((await q('SELECT * FROM otp_guard.risk_events')).rows)
  assert.ok(!dump.includes('9171234567'))
})

test('a release unblocks and resets the evidence', async () => {
  const deviceId = device(3)
  for (let n = 0; n < 20; n++) await createPermit(db.pool, { to: '+639170000001', deviceId })
  assert.equal((await createPermit(db.pool, { to: phone(1), deviceId })).reason, 'DEVICE_BLOCKED')

  await assert.rejects(q("SELECT public.otp_guard_release('device', $1, 'short', 'ops')", [deviceId]), /explain the review/)
  await q("SELECT public.otp_guard_release('device', $1, 'Confirmed legitimate tester', 'ops@example.com')", [deviceId])
  assert.equal((await createPermit(db.pool, { to: phone(1), deviceId })).allowed, true)
  assert.equal(await scalar('SELECT count(*)::int FROM otp_guard.risk_reviews'), 1)

  // One more rejection after the review is not enough to re-block.
  await createPermit(db.pool, { to: '+639170000001', deviceId })
  assert.equal(await scalar(`SELECT status FROM otp_guard.risk_subjects WHERE subject_type = 'device'`), 'released')
})

test('signups: origin limits, destination rules and the permit IP', async () => {
  assert.equal((await scalar("SELECT public.otp_guard_check_signup('203.0.113.60', 'a@example.com')")).allowed, true)
  assert.equal((await scalar("SELECT public.otp_guard_check_signup('203.0.113.60', '')")).allowed, true, 'anonymous')
  assert.equal((await scalar("SELECT public.otp_guard_check_signup('203.0.113.60', '639171234567')")).reason,
    'DESTINATION_NOT_ALLOWED')
  assert.equal((await scalar("SELECT public.otp_guard_check_signup('', 'b@example.com')")).reason, 'ORIGIN_UNAVAILABLE')

  // Through the gateway, Auth reports the gateway's IP. The permit's IP is used instead.
  const gatewayIp = '192.0.2.200'
  for (let i = 1; i <= 5; i++) {
    await createPermit(db.pool, { to: phone(i), ip: `203.0.113.${100 + i}` })
    assert.equal((await scalar('SELECT public.otp_guard_check_signup($1, $2)', [gatewayIp, phone(i).slice(1)])).allowed, true)
  }
  const perOrigin = (await q('SELECT origin_network::text AS n FROM otp_guard.signup_attempts')).rows.map(r => r.n)
  assert.ok(!perOrigin.includes('192.0.2.200/32'))

  for (let i = 0; i < 2; i++) await scalar("SELECT public.otp_guard_check_signup('203.0.113.60', $1)", [`x${i}@example.com`])
  assert.equal((await scalar("SELECT public.otp_guard_check_signup('203.0.113.60', 'y@example.com')")).reason,
    'ORIGIN_SIGNUP_LIMIT')
})

test('API roles cannot call otp-guard, service_role can', async () => {
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(q(`SET ROLE ${role}; SELECT public.otp_guard_status();`), /permission denied/)
    await q('RESET ROLE')
  }
  await q('SET ROLE service_role')
  try {
    assert.equal((await q('SELECT public.otp_guard_status() AS s')).rows[0].s.version, '0.1.0')
    await assert.rejects(q('SELECT * FROM otp_guard.settings'), /permission denied/)
  } finally {
    await q('RESET ROLE')
  }
})

test('presets apply, and never overwrite with p_overwrite => false', async () => {
  await q("SELECT otp_guard.apply_preset('high-volume')")
  assert.equal(await scalar("SELECT value FROM otp_guard.settings WHERE key = 'global.sends_per_day'"), 20000)
  await q("UPDATE otp_guard.settings SET value = 1234 WHERE key = 'global.sends_per_day'")
  await q("SELECT otp_guard.apply_preset('strict', p_overwrite => false)")
  assert.equal(await scalar("SELECT value FROM otp_guard.settings WHERE key = 'global.sends_per_day'"), 1234)
  await assert.rejects(q("SELECT otp_guard.apply_preset('lax')"), /unknown preset/)
})

test('concurrent hooks never overshoot the global ceiling', async () => {
  await q("SELECT otp_guard.apply_preset('high-volume')")
  await q("UPDATE otp_guard.settings SET value = 7 WHERE key = 'global.sends_per_minute'")
  for (let i = 1; i <= 30; i++) await createPermit(db.pool, { to: phone(i) })
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => authorizeSend(db.pool, { to: phone(i + 1) })))
  assert.equal(results.filter(r => r.allowed).length, 7)
  assert.equal(await scalar('SELECT count(*)::int FROM otp_guard.sends'), 7)
})

test('concurrent gateways never issue more permits than the origin allows', async () => {
  const ip = '203.0.113.77'
  const results = await Promise.all(Array.from({ length: 30 }, () => createPermit(db.pool, { to: phone(1), ip })))
  assert.equal(results.filter(r => r.allowed).length, 3)
})

test('purge removes expired rows', async () => {
  await deliver(db.pool, { to: phone(1), deviceId: device(1) })
  await age(db.pool, '25 hours')
  await q("UPDATE otp_guard.device_phones SET last_seen_at = now() - interval '100 days'")
  await q('SELECT otp_guard.purge()')
  assert.equal(await scalar('SELECT count(*)::int FROM otp_guard.permits'), 0)
  assert.equal(await scalar('SELECT count(*)::int FROM otp_guard.sends'), 0)
  assert.equal(await scalar('SELECT count(*)::int FROM otp_guard.device_phones'), 0)
  assert.equal(typeof freshIp(), 'string')
})
