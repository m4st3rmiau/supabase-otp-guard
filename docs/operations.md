# Operations

What to watch once otp-guard is live, and what to do when something happens. Every change below is SQL that takes effect on the next request, with no deploy.

## Check its health

```sql
SELECT public.otp_guard_status();
```

It returns the version, any missing settings, how many countries are allowed, active blocks, and messages sent in the last minute, hour and day. It never returns phone numbers.

## Read the logs

**Dashboard → Edge Functions → *function* → Logs**

| Function | Message | Meaning |
|---|---|---|
| send-sms-hook | `OTP dispatched` | The provider accepted the message. It does not prove delivery. |
| send-sms-hook | `send refused` | A limit refused it; `reason` says which one. |
| send-sms-hook | `global quota near its limit` | The spend ceiling is close. |
| send-sms-hook | `provider rejected the message` | The provider refused; its reason is included. |
| send-sms-hook | `authorization unavailable` | The database did not answer. Nothing was sent. |
| otp-gateway | `permit rejected` | A limit refused the request before Supabase. |
| otp-gateway | `captcha rejected` | Turnstile failed or is misconfigured. |
| before-user-created-hook | `signup refused` | A signup limit or a country rule. |

These are log lines, not alerts. Connect them to your alerting if you have it.

## Useful queries

<details>
<summary><b>What is being refused</b> in the last 24 hours</summary>

```sql
SELECT reason, action, count(*) AS n, count(DISTINCT target_hash) AS numbers
FROM otp_guard.risk_events WHERE occurred_at > now() - interval '24 hours'
GROUP BY 1, 2 ORDER BY n DESC;
```

</details>

<details>
<summary><b>Who is flagged or blocked</b></summary>

```sql
SELECT subject_type, subject_key, risk_level, status, reason, evidence, last_seen_at
FROM otp_guard.risk_subjects ORDER BY last_seen_at DESC;
```

</details>

<details>
<summary><b>Active blocks</b></summary>

```sql
SELECT network, reason, expires_at FROM otp_guard.origin_blocks
WHERE expires_at IS NULL OR expires_at > now();

SELECT device_id, reason, created_at FROM otp_guard.device_blocks;
```

</details>

<details>
<summary><b>Where messages are going</b>, by prefix</summary>

```sql
SELECT left(phone, 6) AS prefix, count(*) FROM otp_guard.sends GROUP BY 1 ORDER BY 2 DESC;
```

</details>

## During an incident

1. **Find the pattern.** Run the queries above: a prefix, an IP address, a device.
2. **Stop it at the narrowest level that works:**

   ```sql
   -- A number range
   INSERT INTO otp_guard.blocked_prefixes (prefix, reason) VALUES ('+52551', 'incident 2026-10-01');

   -- One IP address, for a week
   INSERT INTO otp_guard.origin_blocks (network, reason, expires_at)
   VALUES ('203.0.113.7/32', 'incident 2026-10-01', now() + interval '7 days');

   -- One device
   INSERT INTO otp_guard.device_blocks (device_id, reason)
   VALUES ('00000000-0000-4000-8000-000000000000', 'incident 2026-10-01');
   ```

3. **Lower the ceiling while you investigate**, if the pattern is not clear yet:

   ```sql
   UPDATE otp_guard.settings SET value = 10 WHERE key = 'global.sends_per_hour';
   ```

4. **Put it back** once it is over, and write down what you saw.

> [!WARNING]
> Avoid blocking whole subnets or countries unless you mean it. Mobile carriers put many real users behind a single address.

## Releasing a block

When a real user was blocked by mistake:

```sql
SELECT public.otp_guard_release('device', '<device id>', 'Confirmed legitimate tester', 'ops@example.com');
SELECT public.otp_guard_release('ip', '203.0.113.7', 'Office network, verified with the customer', 'ops@example.com');
```

The release removes the block, records who did it and why in `otp_guard.risk_reviews` together with the previous state, and wipes the slate: only new rejections can block that IP or device again. Limits are not changed.

> [!TIP]
> Building an admin screen? Call `otp_guard_release` from your own server code after checking that the user is an admin. It cannot be called from the browser, on purpose.

## Maintenance

None required: each function cleans up the table it writes to. If your traffic comes in bursts, you can also schedule a full cleanup with pg_cron:

```sql
SELECT cron.schedule('otp-guard-purge', '17 * * * *', 'SELECT otp_guard.purge()');
```
