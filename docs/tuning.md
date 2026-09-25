# Tuning

The right limits depend on your traffic, and nobody else's numbers will fit exactly. Start from a preset, then adjust in this order: the spend ceiling first, everything else only when real users hit it.

## 1. Set the spend ceiling from money

The project-wide ceiling is the only limit that caps your worst day when every other rule fails. Choose it from what you can afford to lose, not from traffic:

1. **Find your normal volume.** Your provider's dashboard shows daily messages. After a few days with otp-guard you can also run `SELECT count(*) FROM otp_guard.sends;`. Take a busy day.
2. **Set the daily ceiling** (`global.sends_per_day`) to about **2 to 3 times** that.
3. **Set the hourly ceiling** (`global.sends_per_hour`) to about 3 times your busiest hour, and the per-minute one so a burst fits: a launch, a marketing push.
4. **Check the bill.** Multiply the daily ceiling by the price of your most expensive allowed country. That is the most one day of abuse can cost you. If it is too much, lower the ceiling or allow fewer countries.

> [!NOTE]
> When the ceiling is reached, real users cannot log in by phone either, until the window moves. That is the trade-off: a bounded cost in exchange for a bounded outage. The send-sms-hook log warns with *global quota near its limit* before it happens.

## 2. Let the countries do most of the work

Pumping pays because of expensive destinations. Allowing only the countries you actually serve removes most of the incentive before any rate limit matters.

## 3. Mind shared IP addresses

Mobile carriers put many customers behind one IPv4 address, and so do offices, universities and some internet providers. The per-origin limits apply to that shared address.

- If most of your users log in on mobile data in one country, `strict` origin limits can refuse real people at peak times. Raise `origin.permits_per_day` first.
- IPv6 is grouped by /64, which is normally a single customer.
- An IP is never blocked just for volume, only for volume **and** cycling through numbers, exactly because of shared addresses. Keep it that way.

## 4. Keep device limits tight

A device ID belongs to one installation of your app, so device limits can be strict. The important one is `device.pending_phones`. It catches the typical attack: one installation behind a rotating VPN, sending codes to number after number that never gets verified. The default of 2 leaves room for one typo. Raise it only if your users often verify several numbers from one device, such as a shared family phone or support staff.

## 5. Leave the per-phone limits alone

They protect a person's phone from being flooded, and they match what users expect from a *Resend code* button: 1 per minute, 5 per half hour. They rarely need changes.

## 6. Adjust automatic blocking last

Only rejections that say something about the requester count toward a block: local limits and country rules, never the spend ceiling or existing blocks. If real users show up as `suspicious` in `otp_guard.risk_subjects`, raise the `risk.suspicious_*` pair before touching `risk.high_*`.

## A rollout that works

1. Deploy with `strict` and your countries.
2. For a week, look at what gets refused:

   ```sql
   SELECT reason, action, count(*) FROM otp_guard.risk_events
   WHERE occurred_at > now() - interval '24 hours' GROUP BY 1, 2 ORDER BY 3 DESC;
   ```

3. Read the results:
   - **Many rejections, many different numbers:** abuse, being stopped as intended.
   - **Rejections from people who then log in fine:** a limit that is too tight. Raise that one setting, and only that one.

All settings and their values per preset are in [Configuration](configuration.md#changing-a-single-limit).
