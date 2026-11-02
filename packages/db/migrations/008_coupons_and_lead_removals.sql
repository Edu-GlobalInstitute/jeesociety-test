-- Coupons are priced and consumed by the API. The browser never decides the
-- amount charged, and a use is counted only after the payment is confirmed.

CREATE TABLE coupons (
  id             bigserial PRIMARY KEY,
  name           text NOT NULL,
  code           text NOT NULL,
  discount_paise integer NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_by     text REFERENCES "user"("id") ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coupons_name_nonempty CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT coupons_code_format CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'),
  CONSTRAINT coupons_discount_positive CHECK (discount_paise > 0)
);

CREATE UNIQUE INDEX coupons_code_case_insensitive_unique
  ON coupons (upper(code));
CREATE INDEX coupons_active_created_idx ON coupons (active, created_at DESC);

CREATE TABLE coupon_redemptions (
  id             bigserial PRIMARY KEY,
  coupon_id      bigint NOT NULL REFERENCES coupons(id),
  user_id        text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  test_id        bigint NOT NULL REFERENCES tests(id),
  payment_id     bigint NOT NULL UNIQUE REFERENCES payments(id),
  discount_paise integer NOT NULL,
  reserved_at    timestamptz NOT NULL DEFAULT now(),
  redeemed_at    timestamptz,
  CONSTRAINT coupon_redemption_discount_nonnegative CHECK (discount_paise >= 0),
  CONSTRAINT coupon_once_per_student UNIQUE (coupon_id, user_id)
);

CREATE INDEX coupon_redemptions_paid_idx
  ON coupon_redemptions (coupon_id, redeemed_at DESC)
  WHERE redeemed_at IS NOT NULL;
CREATE INDEX coupon_redemptions_pending_idx
  ON coupon_redemptions (user_id, test_id)
  WHERE redeemed_at IS NULL;

ALTER TABLE payments
  ADD COLUMN coupon_id bigint REFERENCES coupons(id),
  ADD COLUMN coupon_code text,
  ADD COLUMN coupon_name text,
  ADD COLUMN discount_paise integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT payments_discount_nonnegative CHECK (discount_paise >= 0);

-- Keep a single unpaid order per student/test. Retain the newest prior open
-- order if legacy data already contains duplicates; older pending orders become
-- failed so the unique index can be installed without touching paid records.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY user_id, test_id
           ORDER BY created_at DESC NULLS LAST, id DESC
         ) AS ordinal
    FROM payments
   WHERE status = 'created'
)
UPDATE payments p
   SET status = 'failed', updated_at = now()
  FROM ranked r
 WHERE p.id = r.id AND r.ordinal > 1;

CREATE UNIQUE INDEX payments_one_open_order_per_student_test
  ON payments (user_id, test_id)
  WHERE status = 'created';

-- CRM removal is a soft delete: it hides a lead from sales while preserving the
-- student's account, contact history, payment records and exam data.
CREATE TABLE crm_lead_dismissals (
  user_id    text PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
  removed_by text NOT NULL REFERENCES "user"("id"),
  removed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX crm_lead_dismissals_removed_at_idx
  ON crm_lead_dismissals (removed_at DESC);
