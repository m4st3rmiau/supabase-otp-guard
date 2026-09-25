# Tuning

The right thresholds depend on your traffic, and nobody else's numbers will fit you
exactly. This is how to choose them.

## Start with the global ceiling

It is the only limit that bounds your worst case when everything else fails. Set it
from money, not from traffic:

1. Look up your normal daily sends (provider dashboard, or
   `SELECT count(*) FROM otp_guard.sends` after a few days). Take a busy day.
2. Set `global.sends_per_day` to about 2–3× that.
3. Set `global.sends_per_hour` to about 3× your busiest hour, and
   `global.sends_per_minute` so a burst (a launch, a push notification) fits.
4. Check the product: `global.sends_per_day × your most expensive allowed destination`
   is the most one day of abuse can cost you. If that number scares you, lower the
   ceiling or narrow the destinations.

Exhausting the ceiling stops legitimate logins too, until the window moves. That is
the trade-off. Watch for `global quota near its limit` in the send-sms-hook logs
(`global.warn_percent`).

## Destinations do the most work

Pumping revenue comes from expensive destinations. An allowlist with only the
countries you serve removes most of the incentive before any rate limit matters.

## Origin limits and carrier NAT

Mobile carriers put many subscribers behind one IPv4 address (CGNAT). Offices,
universities and some ISPs do too. `origin.*` limits apply to that shared address, so:

- If most of your users are on mobile data in one country, `strict` origin limits can
  refuse legitimate users at peak. Raise `origin.permits_per_day` first.
- IPv6 is grouped by /64, which normally is one subscriber.
- IPs are never blocked on volume alone, only on volume **and** target rotation, for
  this reason. Keep it that way.

## Device limits

The device ID belongs to one installation, so device limits can be tight. The one
worth protecting is `device.pending_phones`: it is what caught a real attack (one
installation behind a rotating VPN sending codes to six numbers it never verified). A
value of 2 allows one typo; raise it only if your users legitimately verify several
numbers from one device (shared family phones, support staff).

## Phone and account limits

These protect a victim's phone from being flooded and rarely need changes. 1 per
minute and 5 per 30 minutes is what users experience as "resend".

## Risk scoring

Risk only counts rejections that say something about the requester (local limits,
destination rules), never global ceilings or existing blocks. If you see legitimate
users flagged `suspicious` in `otp_guard.risk_subjects`, raise the `risk.suspicious_*`
pair before touching `risk.high_*`.

## A rollout that works

1. Deploy with `strict` and your destinations.
2. For a week, read the rejections:
   ```sql
   SELECT reason, action, count(*) FROM otp_guard.risk_events
   WHERE occurred_at > now() - interval '24 hours' GROUP BY 1, 2 ORDER BY 3 DESC;
   ```
3. A reason with many rejections and a spread of targets is abuse working as intended.
   A reason with rejections from IPs and devices that later verify is a limit that is
   too tight: raise that one setting.
