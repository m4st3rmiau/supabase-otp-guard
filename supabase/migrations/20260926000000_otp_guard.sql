-- supabase-otp-guard 0.1.0
--
-- Abuse protection for Supabase phone OTP. Every paid message needs a one-time permit
-- created by the otp-gateway Edge Function, and every permit and send is checked against
-- rate limits, destination rules and blocks before the SMS provider is contacted.
--
--   No permit -> no SMS -> no bill.
--
-- Tables live in the private `otp_guard` schema, which PostgREST never exposes. The only
-- entry points are the `public.otp_guard_*` functions at the bottom of this file, and only
-- `service_role` may execute them. See docs/architecture.md.
--
-- Rename this file if your project already has later migrations: Supabase applies
-- migrations in filename order.

BEGIN;

CREATE SCHEMA IF NOT EXISTS otp_guard;
REVOKE ALL ON SCHEMA otp_guard FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA otp_guard FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA otp_guard FROM authenticated';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------
-- Configuration
-- ---------------------------------------------------------------------------------------

-- Every threshold lives here. A missing key raises an error instead of silently disabling
-- its rule, so the Edge Functions fail closed. Change values with UPDATE or apply a preset.
CREATE TABLE otp_guard.settings (
  key text PRIMARY KEY,
  value integer NOT NULL CHECK (value > 0),
  description text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Destinations that may receive a code. Empty means nothing is allowed: pick your
-- countries explicitly (see docs/configuration.md). `prefix` is E.164 digits without "+"
-- and may be narrower than a country code. `digits` is the full E.164 length without "+".
CREATE TABLE otp_guard.allowed_destinations (
  prefix text PRIMARY KEY CHECK (prefix ~ '^[1-9][0-9]{0,14}$'),
  digits integer CHECK (digits BETWEEN 8 AND 15),
  label text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Destinations that never receive a code, even inside an allowed country. Literal prefix
-- match: '+63' blocks a country, '+5255123' a range, a full number blocks one number.
CREATE TABLE otp_guard.blocked_prefixes (
  prefix text PRIMARY KEY CHECK (prefix ~ '^\+[1-9][0-9]{0,14}$'),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION otp_guard.preset_values()
RETURNS TABLE (key text, strict integer, balanced integer, high_volume integer, description text)
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT * FROM (VALUES
    ('permit.ttl_seconds', 60, 60, 60,
      'Seconds a gateway permit stays valid for the Send SMS hook.'),
    ('origin.permits_per_minute', 3, 5, 10, 'Permits per origin (IPv4 host or IPv6 /64) per minute.'),
    ('origin.permits_per_30_minutes', 5, 10, 30, 'Permits per origin per 30 minutes.'),
    ('origin.permits_per_day', 10, 30, 100, 'Permits per origin per 24 hours.'),
    ('origin.phones_per_30_minutes', 3, 4, 10, 'Distinct phones per origin per 30 minutes.'),
    ('origin.phones_per_day', 5, 10, 30, 'Distinct phones per origin per 24 hours.'),
    ('device.permits_per_minute', 3, 3, 5, 'Permits per device ID per minute.'),
    ('device.permits_per_day', 10, 15, 20, 'Permits per device ID per 24 hours.'),
    ('device.pending_phones', 2, 2, 3,
      'Unverified phones a device may have received codes for before a new one is refused.'),
    ('device.pending_lookback_days', 90, 90, 30,
      'How long a phone that never verified keeps counting against its device.'),
    ('device.sends_per_day', 10, 15, 20, 'Sends per device ID per 24 hours.'),
    ('phone.sends_per_minute', 1, 1, 1, 'Sends per destination per minute.'),
    ('phone.sends_per_30_minutes', 5, 5, 5, 'Sends per destination per 30 minutes.'),
    ('phone.sends_per_day', 15, 15, 15, 'Sends per destination per 24 hours.'),
    ('account.sends_per_minute', 1, 1, 1, 'Sends per Auth user per minute.'),
    ('account.sends_per_30_minutes', 5, 5, 5, 'Sends per Auth user per 30 minutes.'),
    ('account.sends_per_day', 15, 15, 15, 'Sends per Auth user per 24 hours.'),
    ('account.phones_per_day', 3, 3, 3, 'Distinct destinations per Auth user per 24 hours.'),
    ('global.sends_per_minute', 5, 30, 200, 'Project-wide spend ceiling per minute.'),
    ('global.sends_per_hour', 20, 300, 3000, 'Project-wide spend ceiling per hour.'),
    ('global.sends_per_day', 60, 1500, 20000, 'Project-wide spend ceiling per 24 hours.'),
    ('global.warn_percent', 80, 80, 80, 'Usage percentage at which authorize_send reports near_limit.'),
    ('signup.origin_per_30_minutes', 3, 5, 20, 'Signups per origin per 30 minutes.'),
    ('signup.origin_per_day', 10, 30, 100, 'Signups per origin per 24 hours.'),
    ('signup.device_per_day', 3, 3, 5, 'Signups per device ID per 24 hours.'),
    ('risk.window_minutes', 60, 60, 60, 'Sliding window for risk classification.'),
    ('risk.suspicious_rejections', 6, 6, 10, 'Rejections that, with suspicious_targets, flag a subject.'),
    ('risk.suspicious_targets', 3, 3, 5, 'Distinct rejected targets that, with suspicious_rejections, flag a subject.'),
    ('risk.high_rejections', 20, 20, 40, 'Rejections that, with high_targets, block a subject.'),
    ('risk.high_targets', 8, 8, 15, 'Distinct rejected targets that, with high_rejections, block a subject.'),
    ('risk.device_suspicious_rejections', 10, 10, 15, 'Rejections alone that flag a device.'),
    ('risk.device_high_rejections', 20, 20, 30, 'Rejections alone that block a device.'),
    ('risk.device_pending_rotation', 3, 3, 3,
      'New phones refused for pending verification that block a device.'),
    ('retention.hours', 24, 24, 24, 'Hours to keep permits, sends and events. Values under 24 are treated as 24.')
  ) AS v(key, strict, balanced, high_volume, description);
$$;

-- Presets are starting points. Only `strict` has run in production (a small app in one
-- country); tune the rest with docs/tuning.md. Pass p_overwrite => false to add missing
-- keys without touching values you changed.
CREATE FUNCTION otp_guard.apply_preset(p_preset text, p_overwrite boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_column integer := CASE p_preset WHEN 'strict' THEN 1 WHEN 'balanced' THEN 2
    WHEN 'high-volume' THEN 3 END;
BEGIN
  IF v_column IS NULL THEN
    RAISE EXCEPTION 'otp_guard: unknown preset "%" (use strict, balanced or high-volume)', p_preset;
  END IF;
  INSERT INTO otp_guard.settings AS s (key, value, description)
  SELECT p.key, (ARRAY[p.strict, p.balanced, p.high_volume])[v_column], p.description
  FROM otp_guard.preset_values() p
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, description = EXCLUDED.description, updated_at = now()
    WHERE p_overwrite;
END;
$$;

CREATE FUNCTION otp_guard.setting(p_key text) RETURNS integer
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_value integer;
BEGIN
  SELECT s.value INTO v_value FROM otp_guard.settings s WHERE s.key = p_key;
  IF v_value IS NULL THEN
    RAISE EXCEPTION 'otp_guard: setting "%" is missing; run otp_guard.apply_preset()', p_key;
  END IF;
  RETURN v_value;
END;
$$;

CREATE FUNCTION otp_guard.retention() RETURNS interval
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT make_interval(hours => greatest(24, otp_guard.setting('retention.hours')));
$$;

-- ---------------------------------------------------------------------------------------
-- State
-- ---------------------------------------------------------------------------------------

CREATE TABLE otp_guard.origin_blocks (
  network cidr PRIMARY KEY,
  reason text NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX origin_blocks_network_gist ON otp_guard.origin_blocks USING gist (network inet_ops);

CREATE TABLE otp_guard.device_blocks (
  device_id uuid PRIMARY KEY,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Created by the gateway, consumed by the Send SMS hook. A revoked permit cannot be
-- consumed but still counts toward rate limits, so failing the Auth call on purpose does
-- not erase an attempt.
CREATE TABLE otp_guard.permits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  origin_ip inet NOT NULL,
  origin_network cidr NOT NULL,
  device_id uuid,
  client_platform text NOT NULL CHECK (client_platform IN ('web', 'mobile')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX permits_phone_active_idx ON otp_guard.permits (phone, created_at DESC)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX permits_origin_idx ON otp_guard.permits (origin_network, created_at DESC);
CREATE INDEX permits_device_idx ON otp_guard.permits (device_id, created_at DESC)
  WHERE device_id IS NOT NULL;
CREATE INDEX permits_created_idx ON otp_guard.permits (created_at);

-- One row per authorized send. No FK to auth.users: the hook can run before the signup
-- transaction that creates the user commits.
CREATE TABLE otp_guard.sends (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone text NOT NULL,
  user_id uuid,
  origin_network cidr,
  device_id uuid,
  sent_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX sends_phone_idx ON otp_guard.sends (phone, sent_at DESC);
CREATE INDEX sends_user_idx ON otp_guard.sends (user_id, sent_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX sends_device_idx ON otp_guard.sends (device_id, sent_at DESC) WHERE device_id IS NOT NULL;
CREATE INDEX sends_time_idx ON otp_guard.sends (sent_at);

-- Phones a device received codes for. Kept for device.pending_lookback_days so a device
-- cannot wait out the 24-hour permit retention and start clean.
CREATE TABLE otp_guard.device_phones (
  device_id uuid NOT NULL,
  phone text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (device_id, phone)
);
CREATE INDEX device_phones_seen_idx ON otp_guard.device_phones (last_seen_at);

CREATE TABLE otp_guard.signup_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  origin_network cidr NOT NULL,
  device_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX signup_attempts_origin_idx ON otp_guard.signup_attempts (origin_network, created_at DESC);
CREATE INDEX signup_attempts_device_idx ON otp_guard.signup_attempts (device_id, created_at DESC)
  WHERE device_id IS NOT NULL;
CREATE INDEX signup_attempts_time_idx ON otp_guard.signup_attempts (created_at);

-- Rejections only. Targets are stored as SHA-256 hashes, never in clear, and never the OTP.
CREATE TABLE otp_guard.risk_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  origin_ip inet,
  device_id uuid,
  action text NOT NULL CHECK (action IN ('sms', 'signup')),
  target_hash text,
  reason text NOT NULL,
  abuse_signal boolean NOT NULL
);
CREATE INDEX risk_events_ip_idx ON otp_guard.risk_events (origin_ip, occurred_at DESC)
  WHERE origin_ip IS NOT NULL;
CREATE INDEX risk_events_device_idx ON otp_guard.risk_events (device_id, occurred_at DESC)
  WHERE device_id IS NOT NULL;
CREATE INDEX risk_events_time_idx ON otp_guard.risk_events (occurred_at);

CREATE TABLE otp_guard.risk_subjects (
  subject_type text NOT NULL CHECK (subject_type IN ('ip', 'device')),
  subject_key text NOT NULL,
  risk_level text NOT NULL CHECK (risk_level IN ('suspicious', 'high_risk', 'reviewed')),
  status text NOT NULL CHECK (status IN ('monitoring', 'blocked', 'released')),
  reason text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}',
  first_flagged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  blocked_at timestamptz,
  reviewed_at timestamptz,
  PRIMARY KEY (subject_type, subject_key)
);

CREATE TABLE otp_guard.risk_reviews (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_type text NOT NULL,
  subject_key text NOT NULL,
  actor text NOT NULL,
  reason text NOT NULL,
  previous_state jsonb NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Defense in depth: even if someone exposes the schema, API roles see nothing.
ALTER TABLE otp_guard.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_guard.allowed_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_guard.blocked_prefixes ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_guard.origin_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_guard.device_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_guard.permits ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_guard.sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_guard.device_phones ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_guard.signup_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_guard.risk_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_guard.risk_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_guard.risk_reviews ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------

CREATE FUNCTION otp_guard.decision(p_allowed boolean, p_reason text, p_retry_after integer)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_build_object('allowed', p_allowed, 'reason', p_reason,
    'retry_after', greatest(coalesce(p_retry_after, 0), 0));
$$;

-- Single host only. IPv4-mapped IPv6 shares the IPv4 key; CIDRs and zone IDs are refused.
CREATE FUNCTION otp_guard.ip_address(p_ip text) RETURNS inet
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v_address inet;
BEGIN
  IF p_ip IS NULL OR btrim(p_ip) = '' OR strpos(p_ip, '/') > 0 OR strpos(p_ip, '%') > 0 THEN
    RETURN NULL;
  END IF;
  BEGIN
    v_address := btrim(p_ip)::inet;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;
  IF family(v_address) = 6 AND v_address <<= '::ffff:0:0/96'::inet THEN
    RETURN '0.0.0.0'::inet + (v_address - '::ffff:0:0'::inet);
  END IF;
  RETURN v_address;
END;
$$;

-- Rate limits group IPv6 by /64, because one subscriber gets a whole /64 and rotates
-- inside it. IPv4 limits apply to the single host.
CREATE FUNCTION otp_guard.origin_network(p_address inet) RETURNS cidr
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN p_address IS NULL THEN NULL
    ELSE network(set_masklen(p_address, CASE WHEN family(p_address) = 6 THEN 64 ELSE 32 END)) END;
$$;

CREATE FUNCTION otp_guard.device_uuid(p_device_id text) RETURNS uuid
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN p_device_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN p_device_id::uuid END;
$$;

-- E.164 with a leading "+", or NULL. Auth stores phones without "+", so both forms match.
CREATE FUNCTION otp_guard.normalize_phone(p_phone text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN d ~ '^[1-9][0-9]{7,14}$' THEN '+' || d END
  FROM (SELECT regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') AS d) s;
$$;

CREATE FUNCTION otp_guard.target_hash(p_target text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN nullif(btrim(p_target), '') IS NOT NULL
    THEN encode(sha256(convert_to(lower(btrim(p_target)), 'UTF8')), 'hex') END;
$$;

CREATE FUNCTION otp_guard.retry_after(p_oldest timestamptz, p_window interval, p_now timestamptz)
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT greatest(1, ceil(extract(epoch FROM (p_oldest + p_window - p_now)))::integer);
$$;

-- NULL when the destination may receive a code, otherwise the rejection reason.
CREATE FUNCTION otp_guard.destination_rejection(p_phone text) RETURNS text
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN p_phone IS NULL THEN 'INVALID_PHONE'
    WHEN EXISTS (SELECT 1 FROM otp_guard.blocked_prefixes b WHERE starts_with(p_phone, b.prefix))
      THEN 'BLOCKLISTED'
    WHEN NOT EXISTS (SELECT 1 FROM otp_guard.allowed_destinations a
      WHERE starts_with(p_phone, '+' || a.prefix)
        AND (a.digits IS NULL OR length(p_phone) - 1 = a.digits))
      THEN 'DESTINATION_NOT_ALLOWED'
  END;
$$;

CREATE FUNCTION otp_guard.block_reason(p_address inet, p_device uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN p_address IS NOT NULL AND EXISTS (SELECT 1 FROM otp_guard.origin_blocks b
      WHERE p_address <<= b.network AND (b.expires_at IS NULL OR b.expires_at > clock_timestamp()))
      THEN 'ORIGIN_BLOCKED'
    WHEN p_device IS NOT NULL AND EXISTS (SELECT 1 FROM otp_guard.device_blocks b
      WHERE b.device_id = p_device)
      THEN 'DEVICE_BLOCKED'
  END;
$$;

-- Rejections that count as evidence of abuse. Global ceilings, existing blocks, missing
-- permits and malformed input do not: they say nothing about who is asking.
CREATE FUNCTION otp_guard.signal_reasons() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT ARRAY[
    'ORIGIN_MINUTE_LIMIT', 'ORIGIN_SHORT_LIMIT', 'ORIGIN_DAILY_LIMIT',
    'ORIGIN_DESTINATION_SHORT_LIMIT', 'ORIGIN_DESTINATION_DAILY_LIMIT',
    'DEVICE_MINUTE_LIMIT', 'DEVICE_DAILY_LIMIT', 'DEVICE_PENDING_VERIFICATION', 'DEVICE_SEND_DAILY_LIMIT',
    'PHONE_MINUTE_LIMIT', 'PHONE_SHORT_LIMIT', 'PHONE_DAILY_LIMIT',
    'ACCOUNT_MINUTE_LIMIT', 'ACCOUNT_SHORT_LIMIT', 'ACCOUNT_DAILY_LIMIT', 'ACCOUNT_DESTINATION_LIMIT',
    'ORIGIN_SIGNUP_LIMIT', 'DEVICE_SIGNUP_LIMIT',
    'DESTINATION_NOT_ALLOWED', 'BLOCKLISTED'
  ];
$$;

-- ---------------------------------------------------------------------------------------
-- Risk classification
-- ---------------------------------------------------------------------------------------

-- Lock order is always permits -> risk. authorize_send, check_signup and release take
-- only the risk lock, so no path can deadlock.
CREATE FUNCTION otp_guard.record_risk(p_address inet, p_device uuid, p_target text,
  p_action text, p_reason text)
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_now timestamptz;
  v_window interval;
  v_signal boolean;
  v_subject record;
  v_since timestamptz;
  v_rejects integer;
  v_targets integer;
  v_pending integer;
  v_level text;
  v_rule text;
  v_is_device boolean;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('sms', 'signup') THEN
    RAISE EXCEPTION 'otp_guard: invalid action %', p_action;
  END IF;
  IF p_address IS NULL AND p_device IS NULL THEN RETURN; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('otp_guard:risk', 0));
  v_now := clock_timestamp();
  v_window := make_interval(mins => otp_guard.setting('risk.window_minutes'));
  v_signal := coalesce(p_reason = ANY (otp_guard.signal_reasons()), false);

  DELETE FROM otp_guard.risk_events e WHERE e.occurred_at < v_now - otp_guard.retention();
  INSERT INTO otp_guard.risk_events (origin_ip, device_id, action, target_hash, reason, abuse_signal)
  VALUES (p_address, p_device, p_action, otp_guard.target_hash(p_target), coalesce(p_reason, 'UNKNOWN'), v_signal);
  IF NOT v_signal THEN RETURN; END IF;

  FOR v_subject IN
    SELECT 'ip'::text AS kind, host(p_address) AS key WHERE p_address IS NOT NULL
    UNION ALL
    SELECT 'device'::text, p_device::text WHERE p_device IS NOT NULL
  LOOP
    v_is_device := v_subject.kind = 'device';
    UPDATE otp_guard.risk_subjects s SET last_seen_at = v_now
      WHERE s.subject_type = v_subject.kind AND s.subject_key = v_subject.key;
    IF EXISTS (SELECT 1 FROM otp_guard.risk_subjects s WHERE s.subject_type = v_subject.kind
        AND s.subject_key = v_subject.key AND s.status = 'blocked') THEN
      CONTINUE;
    END IF;

    -- A manual release resets the evidence: only rejections after it can escalate again.
    SELECT greatest(v_now - v_window, coalesce(s.reviewed_at, '-infinity'::timestamptz))
      INTO v_since FROM otp_guard.risk_subjects s
      WHERE s.subject_type = v_subject.kind AND s.subject_key = v_subject.key;
    v_since := coalesce(v_since, v_now - v_window);

    SELECT count(*), count(DISTINCT e.target_hash),
      count(DISTINCT e.target_hash) FILTER (WHERE e.reason = 'DEVICE_PENDING_VERIFICATION')
    INTO v_rejects, v_targets, v_pending
    FROM otp_guard.risk_events e
    WHERE e.abuse_signal AND e.occurred_at > v_since
      AND ((NOT v_is_device AND e.origin_ip = p_address) OR (v_is_device AND e.device_id = p_device));

    -- IPs are shared (carrier NAT, offices), so they are only blocked on volume AND target
    -- rotation. Device IDs belong to one installation, so volume alone is enough.
    v_rule := CASE
      WHEN v_rejects >= otp_guard.setting('risk.high_rejections')
        AND v_targets >= otp_guard.setting('risk.high_targets') THEN 'repeated_rejections_with_target_rotation'
      WHEN v_is_device AND v_pending >= otp_guard.setting('risk.device_pending_rotation')
        THEN 'unverified_destination_rotation'
      WHEN v_is_device AND v_rejects >= otp_guard.setting('risk.device_high_rejections')
        THEN 'repeated_rejections'
      WHEN v_rejects >= otp_guard.setting('risk.suspicious_rejections')
        AND v_targets >= otp_guard.setting('risk.suspicious_targets') THEN 'repeated_rejections_with_target_rotation'
      WHEN v_is_device AND v_rejects >= otp_guard.setting('risk.device_suspicious_rejections')
        THEN 'repeated_rejections'
    END;
    IF v_rule IS NULL THEN CONTINUE; END IF;

    v_level := CASE
      WHEN v_rejects >= otp_guard.setting('risk.high_rejections')
        AND v_targets >= otp_guard.setting('risk.high_targets') THEN 'high_risk'
      WHEN v_is_device AND (v_pending >= otp_guard.setting('risk.device_pending_rotation')
        OR v_rejects >= otp_guard.setting('risk.device_high_rejections')) THEN 'high_risk'
      ELSE 'suspicious'
    END;

    INSERT INTO otp_guard.risk_subjects AS s
      (subject_type, subject_key, risk_level, status, reason, evidence, blocked_at)
    VALUES (v_subject.kind, v_subject.key, v_level,
      CASE WHEN v_level = 'high_risk' THEN 'blocked' ELSE 'monitoring' END, v_rule,
      jsonb_build_object('window_minutes', otp_guard.setting('risk.window_minutes'),
        'rejections', v_rejects, 'distinct_targets', v_targets,
        'pending_verification_targets', v_pending, 'last_reason', p_reason, 'action', p_action),
      CASE WHEN v_level = 'high_risk' THEN v_now END)
    ON CONFLICT (subject_type, subject_key) DO UPDATE SET
      risk_level = EXCLUDED.risk_level, status = EXCLUDED.status, reason = EXCLUDED.reason,
      evidence = EXCLUDED.evidence, last_seen_at = v_now, blocked_at = EXCLUDED.blocked_at;

    IF v_level = 'high_risk' THEN
      IF v_is_device THEN
        INSERT INTO otp_guard.device_blocks (device_id, reason) VALUES (p_device, 'automatic_' || v_rule)
        ON CONFLICT (device_id) DO UPDATE SET reason = EXCLUDED.reason;
      ELSE
        -- Exact host only: never a whole subnet, provider or country.
        INSERT INTO otp_guard.origin_blocks (network, reason, expires_at)
        VALUES (p_address::cidr, 'automatic_' || v_rule, NULL)
        ON CONFLICT (network) DO UPDATE SET reason = EXCLUDED.reason, expires_at = NULL;
      END IF;
    END IF;
  END LOOP;
END;
$$;

-- Records the rejection and returns it, unless the evidence just blocked the subject.
CREATE FUNCTION otp_guard.reject(p_address inet, p_device uuid, p_target text, p_action text,
  p_reason text, p_retry_after integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_blocked text;
BEGIN
  PERFORM otp_guard.record_risk(p_address, p_device, p_target, p_action, p_reason);
  v_blocked := otp_guard.block_reason(p_address, p_device);
  IF v_blocked IS NOT NULL THEN RETURN otp_guard.decision(false, v_blocked, 0); END IF;
  RETURN otp_guard.decision(false, p_reason, p_retry_after);
END;
$$;

-- Optional: schedule with pg_cron if traffic is bursty. Every entry point already purges
-- the table it writes to.
CREATE FUNCTION otp_guard.purge() RETURNS void
LANGUAGE sql SET search_path = '' AS $$
  DELETE FROM otp_guard.permits WHERE created_at < clock_timestamp() - otp_guard.retention();
  DELETE FROM otp_guard.sends WHERE sent_at < clock_timestamp() - otp_guard.retention();
  DELETE FROM otp_guard.signup_attempts WHERE created_at < clock_timestamp() - otp_guard.retention();
  DELETE FROM otp_guard.risk_events WHERE occurred_at < clock_timestamp() - otp_guard.retention();
  DELETE FROM otp_guard.device_phones WHERE last_seen_at <
    clock_timestamp() - make_interval(days => otp_guard.setting('device.pending_lookback_days'));
  DELETE FROM otp_guard.origin_blocks WHERE expires_at IS NOT NULL AND expires_at < clock_timestamp();
$$;

-- ---------------------------------------------------------------------------------------
-- Entry points (service_role only)
-- ---------------------------------------------------------------------------------------

-- Called by otp-gateway before Supabase Auth. The IP comes from the gateway request and
-- is required: a missing origin fails closed.
CREATE FUNCTION public.otp_guard_create_permit(p_phone text, p_ip text, p_device_id text,
  p_client_platform text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_phone text := otp_guard.normalize_phone(p_phone);
  v_address inet := otp_guard.ip_address(p_ip);
  v_origin cidr := otp_guard.origin_network(otp_guard.ip_address(p_ip));
  v_device uuid := otp_guard.device_uuid(p_device_id);
  v_platform text := lower(btrim(coalesce(p_client_platform, '')));
  v_now timestamptz;
  v_reason text;
  v_retry integer := 0;
  v_min integer; v_min_at timestamptz;
  v_short integer; v_short_at timestamptz;
  v_day integer; v_day_at timestamptz;
  v_phones_short integer; v_phones_day integer;
  v_known_short boolean; v_known_day boolean;
  v_pending integer; v_known_pending boolean;
  v_permit otp_guard.permits;
BEGIN
  IF v_phone IS NULL THEN RETURN otp_guard.decision(false, 'INVALID_PHONE', 0); END IF;
  IF v_platform NOT IN ('web', 'mobile') THEN
    RETURN otp_guard.decision(false, 'INVALID_PLATFORM', 0);
  END IF;
  IF v_address IS NULL THEN RETURN otp_guard.decision(false, 'ORIGIN_UNAVAILABLE', 60); END IF;

  v_reason := otp_guard.block_reason(v_address, v_device);
  IF v_reason IS NOT NULL THEN RETURN otp_guard.decision(false, v_reason, 0); END IF;

  -- Before Auth runs: a foreign number never becomes an account that cannot verify.
  v_reason := otp_guard.destination_rejection(v_phone);
  IF v_reason IS NOT NULL THEN
    RETURN otp_guard.reject(v_address, v_device, v_phone, 'sms', v_reason, 0);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('otp_guard:permits', 0));
  v_now := clock_timestamp();
  DELETE FROM otp_guard.permits p WHERE p.created_at < v_now - otp_guard.retention();

  SELECT count(*) FILTER (WHERE p.created_at > v_now - interval '1 minute'),
    min(p.created_at) FILTER (WHERE p.created_at > v_now - interval '1 minute'),
    count(*) FILTER (WHERE p.created_at > v_now - interval '30 minutes'),
    min(p.created_at) FILTER (WHERE p.created_at > v_now - interval '30 minutes'),
    count(*), min(p.created_at),
    count(DISTINCT p.phone) FILTER (WHERE p.created_at > v_now - interval '30 minutes'),
    count(DISTINCT p.phone),
    coalesce(bool_or(p.phone = v_phone) FILTER (WHERE p.created_at > v_now - interval '30 minutes'), false),
    coalesce(bool_or(p.phone = v_phone), false)
  INTO v_min, v_min_at, v_short, v_short_at, v_day, v_day_at,
    v_phones_short, v_phones_day, v_known_short, v_known_day
  FROM otp_guard.permits p
  WHERE p.origin_network = v_origin AND p.created_at > v_now - interval '24 hours';

  IF v_min >= otp_guard.setting('origin.permits_per_minute') THEN
    v_reason := 'ORIGIN_MINUTE_LIMIT';
    v_retry := otp_guard.retry_after(v_min_at, interval '1 minute', v_now);
  ELSIF v_short >= otp_guard.setting('origin.permits_per_30_minutes') THEN
    v_reason := 'ORIGIN_SHORT_LIMIT';
    v_retry := otp_guard.retry_after(v_short_at, interval '30 minutes', v_now);
  ELSIF v_day >= otp_guard.setting('origin.permits_per_day') THEN
    v_reason := 'ORIGIN_DAILY_LIMIT';
    v_retry := otp_guard.retry_after(v_day_at, interval '24 hours', v_now);
  END IF;

  IF v_reason IS NULL AND v_device IS NOT NULL THEN
    SELECT count(*) FILTER (WHERE p.created_at > v_now - interval '1 minute'),
      min(p.created_at) FILTER (WHERE p.created_at > v_now - interval '1 minute'),
      count(*), min(p.created_at)
    INTO v_min, v_min_at, v_day, v_day_at
    FROM otp_guard.permits p
    WHERE p.device_id = v_device AND p.created_at > v_now - interval '24 hours';
    IF v_min >= otp_guard.setting('device.permits_per_minute') THEN
      v_reason := 'DEVICE_MINUTE_LIMIT';
      v_retry := otp_guard.retry_after(v_min_at, interval '1 minute', v_now);
    ELSIF v_day >= otp_guard.setting('device.permits_per_day') THEN
      v_reason := 'DEVICE_DAILY_LIMIT';
      v_retry := otp_guard.retry_after(v_day_at, interval '24 hours', v_now);
    END IF;
  END IF;

  -- The rule that catches destination rotation from one installation behind a rotating
  -- VPN: after `device.pending_phones` numbers that never verified, a new number is
  -- refused. Resending to one of them, or logging in to an already verified number, works.
  IF v_reason IS NULL AND v_device IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM auth.users u WHERE u.phone = ltrim(v_phone, '+') AND u.phone_confirmed_at IS NOT NULL) THEN
    SELECT count(*), coalesce(bool_or(d.phone = v_phone), false)
    INTO v_pending, v_known_pending
    FROM otp_guard.device_phones d
    WHERE d.device_id = v_device
      AND d.last_seen_at > v_now - make_interval(days => otp_guard.setting('device.pending_lookback_days'))
      AND NOT EXISTS (SELECT 1 FROM auth.users u
        WHERE u.phone = ltrim(d.phone, '+') AND u.phone_confirmed_at IS NOT NULL);
    IF v_pending >= otp_guard.setting('device.pending_phones') AND NOT v_known_pending THEN
      v_reason := 'DEVICE_PENDING_VERIFICATION';
      v_retry := 86400;
    END IF;
  END IF;

  IF v_reason IS NULL AND NOT v_known_short
      AND v_phones_short >= otp_guard.setting('origin.phones_per_30_minutes') THEN
    v_reason := 'ORIGIN_DESTINATION_SHORT_LIMIT';
    v_retry := 1800;
  ELSIF v_reason IS NULL AND NOT v_known_day
      AND v_phones_day >= otp_guard.setting('origin.phones_per_day') THEN
    v_reason := 'ORIGIN_DESTINATION_DAILY_LIMIT';
    v_retry := 86400;
  END IF;

  IF v_reason IS NOT NULL THEN
    RETURN otp_guard.reject(v_address, v_device, v_phone, 'sms', v_reason, v_retry);
  END IF;

  INSERT INTO otp_guard.permits (phone, origin_ip, origin_network, device_id, client_platform, expires_at)
  VALUES (v_phone, v_address, v_origin, v_device, v_platform,
    v_now + make_interval(secs => otp_guard.setting('permit.ttl_seconds')))
  RETURNING * INTO v_permit;

  RETURN otp_guard.decision(true, NULL, 0) || jsonb_build_object(
    'permit_id', v_permit.id, 'phone', v_phone, 'expires_at', v_permit.expires_at);
END;
$$;

-- Called by otp-gateway when the Auth request fails, so the permit cannot be used later.
-- It still counts toward the limits above.
CREATE FUNCTION public.otp_guard_revoke_permit(p_permit_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE otp_guard.permits SET revoked_at = clock_timestamp()
  WHERE id = p_permit_id AND consumed_at IS NULL AND revoked_at IS NULL;
$$;

-- Called by the Send SMS hook right before the provider. Consumes the permit and reserves
-- quota in one transaction under one lock: concurrent hooks cannot overshoot a limit.
-- A consumed permit stays consumed even if a limit rejects the send.
CREATE FUNCTION public.otp_guard_authorize_send(p_phone text, p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_phone text := otp_guard.normalize_phone(p_phone);
  v_now timestamptz;
  v_permit otp_guard.permits;
  v_reason text;
  v_retry integer := 0;
  v_min integer; v_min_at timestamptz;
  v_short integer; v_short_at timestamptz;
  v_day integer; v_day_at timestamptz;
  v_hour integer; v_hour_at timestamptz;
  v_account_phones integer; v_known_account_phone boolean; v_oldest_account_phone timestamptz;
  v_warn integer;
BEGIN
  IF v_phone IS NULL THEN RETURN otp_guard.decision(false, 'INVALID_PHONE', 0); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('otp_guard:risk', 0));
  v_now := clock_timestamp();

  UPDATE otp_guard.permits p SET consumed_at = v_now
  WHERE p.id = (SELECT q.id FROM otp_guard.permits q
    WHERE q.phone = v_phone AND q.consumed_at IS NULL AND q.revoked_at IS NULL AND q.expires_at > v_now
    ORDER BY q.created_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED)
  RETURNING * INTO v_permit;
  IF v_permit.id IS NULL THEN RETURN otp_guard.decision(false, 'SEND_PERMIT_REQUIRED', 0); END IF;

  -- The subject may have been blocked since the permit was issued.
  v_reason := otp_guard.block_reason(v_permit.origin_ip, v_permit.device_id);
  IF v_reason IS NOT NULL THEN RETURN otp_guard.decision(false, v_reason, 0); END IF;
  v_reason := otp_guard.destination_rejection(v_phone);
  IF v_reason IS NOT NULL THEN
    RETURN otp_guard.reject(v_permit.origin_ip, v_permit.device_id, v_phone, 'sms', v_reason, 0);
  END IF;

  DELETE FROM otp_guard.sends s WHERE s.sent_at < v_now - otp_guard.retention();

  SELECT count(*) FILTER (WHERE s.sent_at > v_now - interval '1 minute'),
    min(s.sent_at) FILTER (WHERE s.sent_at > v_now - interval '1 minute'),
    count(*) FILTER (WHERE s.sent_at > v_now - interval '30 minutes'),
    min(s.sent_at) FILTER (WHERE s.sent_at > v_now - interval '30 minutes'),
    count(*), min(s.sent_at)
  INTO v_min, v_min_at, v_short, v_short_at, v_day, v_day_at
  FROM otp_guard.sends s WHERE s.phone = v_phone AND s.sent_at > v_now - interval '24 hours';
  IF v_min >= otp_guard.setting('phone.sends_per_minute') THEN
    v_reason := 'PHONE_MINUTE_LIMIT'; v_retry := otp_guard.retry_after(v_min_at, interval '1 minute', v_now);
  ELSIF v_short >= otp_guard.setting('phone.sends_per_30_minutes') THEN
    v_reason := 'PHONE_SHORT_LIMIT'; v_retry := otp_guard.retry_after(v_short_at, interval '30 minutes', v_now);
  ELSIF v_day >= otp_guard.setting('phone.sends_per_day') THEN
    v_reason := 'PHONE_DAILY_LIMIT'; v_retry := otp_guard.retry_after(v_day_at, interval '24 hours', v_now);
  END IF;

  IF v_reason IS NULL AND p_user_id IS NOT NULL THEN
    SELECT count(*) FILTER (WHERE s.sent_at > v_now - interval '1 minute'),
      min(s.sent_at) FILTER (WHERE s.sent_at > v_now - interval '1 minute'),
      count(*) FILTER (WHERE s.sent_at > v_now - interval '30 minutes'),
      min(s.sent_at) FILTER (WHERE s.sent_at > v_now - interval '30 minutes'),
      count(*), min(s.sent_at)
    INTO v_min, v_min_at, v_short, v_short_at, v_day, v_day_at
    FROM otp_guard.sends s WHERE s.user_id = p_user_id AND s.sent_at > v_now - interval '24 hours';
    IF v_min >= otp_guard.setting('account.sends_per_minute') THEN
      v_reason := 'ACCOUNT_MINUTE_LIMIT'; v_retry := otp_guard.retry_after(v_min_at, interval '1 minute', v_now);
    ELSIF v_short >= otp_guard.setting('account.sends_per_30_minutes') THEN
      v_reason := 'ACCOUNT_SHORT_LIMIT'; v_retry := otp_guard.retry_after(v_short_at, interval '30 minutes', v_now);
    ELSIF v_day >= otp_guard.setting('account.sends_per_day') THEN
      v_reason := 'ACCOUNT_DAILY_LIMIT'; v_retry := otp_guard.retry_after(v_day_at, interval '24 hours', v_now);
    END IF;

    IF v_reason IS NULL THEN
      -- Distinct destinations include the registered number. A resend to a known one is fine.
      SELECT count(*), coalesce(bool_or(d.phone = v_phone), false), min(d.last_sent)
      INTO v_account_phones, v_known_account_phone, v_oldest_account_phone
      FROM (SELECT s.phone, max(s.sent_at) AS last_sent FROM otp_guard.sends s
        WHERE s.user_id = p_user_id AND s.sent_at > v_now - interval '24 hours' GROUP BY s.phone) d;
      IF v_account_phones >= otp_guard.setting('account.phones_per_day') AND NOT v_known_account_phone THEN
        v_reason := 'ACCOUNT_DESTINATION_LIMIT';
        v_retry := otp_guard.retry_after(v_oldest_account_phone, interval '24 hours', v_now);
      END IF;
    END IF;
  END IF;

  IF v_reason IS NULL AND v_permit.device_id IS NOT NULL THEN
    SELECT count(*), min(s.sent_at) INTO v_day, v_day_at FROM otp_guard.sends s
    WHERE s.device_id = v_permit.device_id AND s.sent_at > v_now - interval '24 hours';
    IF v_day >= otp_guard.setting('device.sends_per_day') THEN
      v_reason := 'DEVICE_SEND_DAILY_LIMIT'; v_retry := otp_guard.retry_after(v_day_at, interval '24 hours', v_now);
    END IF;
  END IF;

  -- The spend ceiling. Exhausting it also stops legitimate users until the window moves;
  -- that is the point: it caps the worst case when every other rule has failed.
  SELECT count(*) FILTER (WHERE s.sent_at > v_now - interval '1 minute'),
    min(s.sent_at) FILTER (WHERE s.sent_at > v_now - interval '1 minute'),
    count(*) FILTER (WHERE s.sent_at > v_now - interval '1 hour'),
    min(s.sent_at) FILTER (WHERE s.sent_at > v_now - interval '1 hour'),
    count(*), min(s.sent_at)
  INTO v_min, v_min_at, v_hour, v_hour_at, v_day, v_day_at
  FROM otp_guard.sends s WHERE s.sent_at > v_now - interval '24 hours';
  IF v_reason IS NULL THEN
    IF v_min >= otp_guard.setting('global.sends_per_minute') THEN
      v_reason := 'GLOBAL_MINUTE_LIMIT'; v_retry := otp_guard.retry_after(v_min_at, interval '1 minute', v_now);
    ELSIF v_hour >= otp_guard.setting('global.sends_per_hour') THEN
      v_reason := 'GLOBAL_HOURLY_LIMIT'; v_retry := otp_guard.retry_after(v_hour_at, interval '1 hour', v_now);
    ELSIF v_day >= otp_guard.setting('global.sends_per_day') THEN
      v_reason := 'GLOBAL_DAILY_LIMIT'; v_retry := otp_guard.retry_after(v_day_at, interval '24 hours', v_now);
    END IF;
  END IF;

  IF v_reason IS NOT NULL THEN
    RETURN otp_guard.reject(v_permit.origin_ip, v_permit.device_id, v_phone, 'sms', v_reason, v_retry);
  END IF;

  INSERT INTO otp_guard.sends (phone, user_id, origin_network, device_id, sent_at)
  VALUES (v_phone, p_user_id, v_permit.origin_network, v_permit.device_id, v_now);
  IF v_permit.device_id IS NOT NULL THEN
    INSERT INTO otp_guard.device_phones AS d (device_id, phone, first_seen_at, last_seen_at)
    VALUES (v_permit.device_id, v_phone, v_now, v_now)
    ON CONFLICT (device_id, phone) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at;
  END IF;

  v_warn := otp_guard.setting('global.warn_percent');
  RETURN otp_guard.decision(true, NULL, 0) || jsonb_build_object(
    'client_platform', v_permit.client_platform,
    'usage', jsonb_build_object('minute', v_min + 1, 'hour', v_hour + 1, 'day', v_day + 1),
    'near_limit',
      (v_min + 1) * 100 >= v_warn * otp_guard.setting('global.sends_per_minute')
      OR (v_hour + 1) * 100 >= v_warn * otp_guard.setting('global.sends_per_hour')
      OR (v_day + 1) * 100 >= v_warn * otp_guard.setting('global.sends_per_day'));
END;
$$;

-- Called by the Before User Created hook. Auth passes the client IP in that hook's
-- payload, but for signups started through otp-gateway that IP is the gateway's. So an
-- active permit for the same phone, which recorded the real client IP and device, wins.
CREATE FUNCTION public.otp_guard_check_signup(p_ip text, p_target text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  -- Anonymous and some OAuth signups carry neither phone nor email: origin limits only.
  v_is_phone boolean := nullif(btrim(p_target), '') IS NOT NULL AND strpos(p_target, '@') = 0;
  v_phone text;
  v_target text;
  v_address inet := otp_guard.ip_address(p_ip);
  v_device uuid;
  v_permit otp_guard.permits;
  v_now timestamptz;
  v_origin cidr;
  v_short integer; v_day integer; v_device_day integer;
  v_reason text;
  v_retry integer := 0;
BEGIN
  IF v_is_phone THEN
    v_phone := otp_guard.normalize_phone(p_target);
    v_target := v_phone;
    IF v_phone IS NOT NULL THEN
      SELECT * INTO v_permit FROM otp_guard.permits p
      WHERE p.phone = v_phone AND p.revoked_at IS NULL AND p.expires_at > clock_timestamp()
      ORDER BY p.created_at DESC LIMIT 1;
      IF v_permit.id IS NOT NULL THEN
        v_address := v_permit.origin_ip;
        v_device := v_permit.device_id;
      END IF;
    END IF;
  ELSE
    v_target := nullif(lower(btrim(p_target)), '');
  END IF;

  IF v_address IS NULL THEN RETURN otp_guard.decision(false, 'ORIGIN_UNAVAILABLE', 60); END IF;
  v_reason := otp_guard.block_reason(v_address, v_device);
  IF v_reason IS NOT NULL THEN RETURN otp_guard.decision(false, v_reason, 0); END IF;
  IF v_is_phone THEN
    v_reason := otp_guard.destination_rejection(v_phone);
    IF v_reason IS NOT NULL THEN
      RETURN otp_guard.reject(v_address, v_device, v_target, 'signup', v_reason, 0);
    END IF;
  END IF;

  v_origin := otp_guard.origin_network(v_address);
  PERFORM pg_advisory_xact_lock(hashtextextended('otp_guard:risk', 0));
  v_now := clock_timestamp();
  DELETE FROM otp_guard.signup_attempts a WHERE a.created_at < v_now - otp_guard.retention();

  IF v_device IS NOT NULL THEN
    SELECT count(*) INTO v_device_day FROM otp_guard.signup_attempts a
    WHERE a.device_id = v_device AND a.created_at > v_now - interval '24 hours';
    IF v_device_day >= otp_guard.setting('signup.device_per_day') THEN
      v_reason := 'DEVICE_SIGNUP_LIMIT'; v_retry := 86400;
    END IF;
  END IF;
  IF v_reason IS NULL THEN
    SELECT count(*) FILTER (WHERE a.created_at > v_now - interval '30 minutes'), count(*)
    INTO v_short, v_day FROM otp_guard.signup_attempts a
    WHERE a.origin_network = v_origin AND a.created_at > v_now - interval '24 hours';
    IF v_day >= otp_guard.setting('signup.origin_per_day') THEN
      v_reason := 'ORIGIN_SIGNUP_LIMIT'; v_retry := 86400;
    ELSIF v_short >= otp_guard.setting('signup.origin_per_30_minutes') THEN
      v_reason := 'ORIGIN_SIGNUP_LIMIT'; v_retry := 1800;
    END IF;
  END IF;
  IF v_reason IS NOT NULL THEN
    RETURN otp_guard.reject(v_address, v_device, v_target, 'signup', v_reason, v_retry);
  END IF;

  INSERT INTO otp_guard.signup_attempts (origin_network, device_id) VALUES (v_origin, v_device);
  RETURN otp_guard.decision(true, NULL, 0);
END;
$$;

-- Manual review. Removes the block and keeps the previous state; only rejections after
-- the review can escalate the subject again.
CREATE FUNCTION public.otp_guard_release(p_subject_type text, p_subject_key text,
  p_reason text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_previous otp_guard.risk_subjects;
BEGIN
  IF p_subject_type NOT IN ('ip', 'device') THEN RAISE EXCEPTION 'otp_guard: subject type must be ip or device'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 10 OR length(p_reason) > 1000 THEN
    RAISE EXCEPTION 'otp_guard: explain the review (10 to 1000 characters)';
  END IF;
  IF nullif(btrim(p_actor), '') IS NULL THEN RAISE EXCEPTION 'otp_guard: actor is required'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('otp_guard:risk', 0));
  SELECT * INTO v_previous FROM otp_guard.risk_subjects s
  WHERE s.subject_type = p_subject_type AND s.subject_key = p_subject_key;

  IF p_subject_type = 'ip' THEN
    DELETE FROM otp_guard.origin_blocks b WHERE b.network = otp_guard.ip_address(p_subject_key)::cidr;
  ELSE
    DELETE FROM otp_guard.device_blocks b WHERE b.device_id = otp_guard.device_uuid(p_subject_key);
  END IF;

  INSERT INTO otp_guard.risk_reviews (subject_type, subject_key, actor, reason, previous_state)
  VALUES (p_subject_type, p_subject_key, btrim(p_actor), btrim(p_reason), coalesce(to_jsonb(v_previous), '{}'));

  INSERT INTO otp_guard.risk_subjects AS s (subject_type, subject_key, risk_level, status, reason, reviewed_at)
  VALUES (p_subject_type, p_subject_key, 'reviewed', 'released', 'manual_release', clock_timestamp())
  ON CONFLICT (subject_type, subject_key) DO UPDATE SET
    risk_level = 'reviewed', status = 'released', reviewed_at = clock_timestamp(), blocked_at = NULL;

  RETURN jsonb_build_object('released', true, 'subject_type', p_subject_type, 'subject_key', p_subject_key);
END;
$$;

-- Health and usage, for operators and scripts/verify.mjs. Never returns phones.
CREATE FUNCTION public.otp_guard_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'version', '0.1.0',
    'missing_settings', coalesce((SELECT jsonb_agg(p.key ORDER BY p.key) FROM otp_guard.preset_values() p
      WHERE NOT EXISTS (SELECT 1 FROM otp_guard.settings s WHERE s.key = p.key)), '[]'),
    'allowed_destinations', (SELECT count(*) FROM otp_guard.allowed_destinations),
    'blocked_prefixes', (SELECT count(*) FROM otp_guard.blocked_prefixes),
    'sends', jsonb_build_object(
      'minute', (SELECT count(*) FROM otp_guard.sends WHERE sent_at > clock_timestamp() - interval '1 minute'),
      'hour', (SELECT count(*) FROM otp_guard.sends WHERE sent_at > clock_timestamp() - interval '1 hour'),
      'day', (SELECT count(*) FROM otp_guard.sends WHERE sent_at > clock_timestamp() - interval '24 hours')),
    'blocks', jsonb_build_object(
      'origins', (SELECT count(*) FROM otp_guard.origin_blocks
        WHERE expires_at IS NULL OR expires_at > clock_timestamp()),
      'devices', (SELECT count(*) FROM otp_guard.device_blocks)),
    'monitoring', (SELECT count(*) FROM otp_guard.risk_subjects WHERE status = 'monitoring'));
$$;

-- ---------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------

-- Supabase grants EXECUTE on new public functions to anon and authenticated by default.
-- These must only ever run from the Edge Functions with the service role key.
DO $$
DECLARE
  v_fn text;
  v_role text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.otp_guard_create_permit(text, text, text, text)',
    'public.otp_guard_revoke_permit(uuid)',
    'public.otp_guard_authorize_send(text, uuid)',
    'public.otp_guard_check_signup(text, text)',
    'public.otp_guard_release(text, text, text, text)',
    'public.otp_guard_status()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', v_fn, v_role);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
    END IF;
  END LOOP;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA otp_guard FROM PUBLIC;

SELECT otp_guard.apply_preset('strict', p_overwrite => false);

NOTIFY pgrst, 'reload schema';
COMMIT;
