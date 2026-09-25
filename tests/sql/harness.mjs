// Throwaway PostgreSQL with the Supabase pieces the migration touches (roles and a stub
// auth.users). Never connects to a real project and never sends SMS.
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'

// Every migration, in filename order, exactly as `supabase db push` applies them.
const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url)

export async function startDatabase(port) {
  const directory = await mkdtemp(join(tmpdir(), 'otp-guard-pg-'))
  const server = new EmbeddedPostgres({
    databaseDir: directory, port, user: 'postgres', password: 'local-test-only',
    persistent: false, onLog() {},
    onError(message) { if (String(message).includes('FATAL')) console.error(message) },
  })
  await server.initialise()
  await server.start()
  const pool = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres',
    password: 'local-test-only', database: 'postgres', max: 20 })
  await pool.query(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    -- Mirror Supabase's default: new public functions are executable by the API roles.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), phone text UNIQUE,
      phone_confirmed_at timestamptz, created_at timestamptz DEFAULT now());`)
  for (const file of (await readdir(MIGRATIONS)).filter(f => f.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, MIGRATIONS), 'utf8'))
  }

  async function stop() {
    await pool.end()
    await server.stop()
    await rm(directory, { recursive: true, force: true })
  }
  return { pool, stop }
}

// Clears state between tests and restores the strict preset plus Mexico as destination.
export async function reset(pool) {
  await pool.query(`TRUNCATE otp_guard.permits, otp_guard.sends, otp_guard.device_phones,
    otp_guard.signup_attempts, otp_guard.risk_events, otp_guard.risk_subjects, otp_guard.risk_reviews,
    otp_guard.origin_blocks, otp_guard.device_blocks, otp_guard.allowed_destinations,
    otp_guard.blocked_prefixes, auth.users`)
  await pool.query(`SELECT otp_guard.apply_preset('strict')`)
  await pool.query(`INSERT INTO otp_guard.allowed_destinations (prefix, digits, label) VALUES ('52', 12, 'Mexico')`)
}

export const phone = i => `+5255${String(i).padStart(8, '0')}`
export const device = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`

let ipSeed = 0
// A different documentation-range IP on every call, like a rotating VPN.
export const freshIp = () => { ipSeed++; return `198.51.${Math.floor(ipSeed / 250) % 250}.${ipSeed % 250 + 1}` }

export async function createPermit(pool, { to, ip = freshIp(), deviceId = null, platform = 'mobile' }) {
  return (await pool.query('SELECT public.otp_guard_create_permit($1, $2, $3, $4) AS d',
    [to, ip, deviceId, platform])).rows[0].d
}

export async function authorizeSend(pool, { to, userId = null }) {
  return (await pool.query('SELECT public.otp_guard_authorize_send($1, $2) AS d', [to, userId])).rows[0].d
}

// Gateway + hook for one OTP, then ages every row so per-minute limits do not interfere.
export async function deliver(pool, options) {
  const permit = await createPermit(pool, options)
  if (!permit.allowed) return permit
  const send = await authorizeSend(pool, { to: options.to, userId: options.userId ?? null })
  await age(pool, '2 minutes')
  return send
}

export async function age(pool, interval) {
  await pool.query(`UPDATE otp_guard.permits SET created_at = created_at - $1::interval,
    expires_at = expires_at - $1::interval`, [interval])
  await pool.query(`UPDATE otp_guard.sends SET sent_at = sent_at - $1::interval`, [interval])
}
