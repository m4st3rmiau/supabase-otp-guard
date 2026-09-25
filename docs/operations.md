# Operations

## Health

```sql
SELECT public.otp_guard_status();
```

Returns the version, missing settings, destination and block counts, and sends in the
last minute, hour and day. It never returns phones.

## Logs

In the Edge Function logs:

| Function | Message | Meaning |
|---|---|---|
| send-sms-hook | `OTP dispatched` | The provider accepted the message. Not proof of delivery |
| send-sms-hook | `send refused` | A rule refused it; `reason` says which |
| send-sms-hook | `global quota near its limit` | Past `global.warn_percent` |
| send-sms-hook | `authorization unavailable` | Postgres failed; nothing was sent |
| send-sms-hook | `provider rejected the message` | Provider error; quota stays consumed |
| otp-gateway | `permit rejected` | A rule refused the permit |
| otp-gateway | `captcha rejected` | Turnstile failed or is misconfigured |
| before-user-created-hook | `signup refused` | Signup limit or destination |

These are logs, not alerts. Wire them to your alerting if you have it.

## Useful queries

```sql
-- What is being refused, last 24 hours
SELECT reason, action, count(*) AS n, count(DISTINCT target_hash) AS targets
FROM otp_guard.risk_events WHERE occurred_at > now() - interval '24 hours'
GROUP BY 1, 2 ORDER BY n DESC;

-- Who is flagged or blocked
SELECT subject_type, subject_key, risk_level, status, reason, evidence, last_seen_at
FROM otp_guard.risk_subjects ORDER BY last_seen_at DESC;

-- Active blocks
SELECT network, reason, expires_at FROM otp_guard.origin_blocks
WHERE expires_at IS NULL OR expires_at > now();
SELECT device_id, reason, created_at FROM otp_guard.device_blocks;

-- Sends by destination prefix, to spot a country or range
SELECT left(phone, 6) AS prefix, count(*) FROM otp_guard.sends GROUP BY 1 ORDER BY 2 DESC;
```

## During an incident

Everything below takes effect on the next request, with no deploy.

```sql
-- Stop a range
INSERT INTO otp_guard.blocked_prefixes (prefix, reason) VALUES ('+52551', 'incident 2026-10-01');

-- Block an IP for a week, or a device
INSERT INTO otp_guard.origin_blocks (network, reason, expires_at)
VALUES ('203.0.113.7/32', 'incident 2026-10-01', now() + interval '7 days');
INSERT INTO otp_guard.device_blocks (device_id, reason)
VALUES ('00000000-0000-4000-8000-000000000000', 'incident 2026-10-01');

-- Cut the spend ceiling while you investigate
UPDATE otp_guard.settings SET value = 10 WHERE key = 'global.sends_per_hour';
```

Avoid blocking whole subnets or countries unless you mean it: carrier NAT puts many
real users behind one address.

## Releasing a block

```sql
SELECT public.otp_guard_release('device', '<device id>', 'Confirmed legitimate tester', 'ops@example.com');
SELECT public.otp_guard_release('ip', '203.0.113.7', 'Office NAT, verified with the customer', 'ops@example.com');
```

The release removes the block, records who did it and why in `otp_guard.risk_reviews`
with the previous state, and resets the evidence: only rejections after the release
can escalate the subject again. It does not change any limit.

To build an admin screen, call `otp_guard_release` from your own server code after
checking that the caller is an admin. It is not callable from the browser on purpose.

## Maintenance

Each entry point purges the table it writes to, so no job is required. For bursty
traffic, you can also schedule a full purge with pg_cron:

```sql
SELECT cron.schedule('otp-guard-purge', '17 * * * *', 'SELECT otp_guard.purge()');
```
