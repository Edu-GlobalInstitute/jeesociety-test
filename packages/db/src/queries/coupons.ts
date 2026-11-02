import { one, rows, type Queryable } from '../query.js';

export interface CouponRow {
  id: number;
  name: string;
  code: string;
  discount_paise: number;
  active: boolean;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
}

export interface CouponAdminRow extends CouponRow {
  redeemed_count: number;
  pending_count: number;
}

const COUPON_COLUMNS = `id, name, code, discount_paise, active, created_at, updated_at, created_by`;

export function findActiveCouponByCode(code: string, db?: Queryable): Promise<CouponRow | null> {
  return one<CouponRow>(
    `SELECT ${COUPON_COLUMNS} FROM coupons
      WHERE upper(code) = upper($1) AND active = true`,
    [code],
    db,
  );
}

export function findCouponById(id: number, db?: Queryable): Promise<CouponRow | null> {
  return one<CouponRow>(`SELECT ${COUPON_COLUMNS} FROM coupons WHERE id = $1`, [id], db);
}

export function findRedemption(
  params: { couponId: number; userId: string },
  db?: Queryable,
): Promise<{ payment_id: number; redeemed_at: Date | null } | null> {
  return one(
    `SELECT payment_id, redeemed_at FROM coupon_redemptions
      WHERE coupon_id = $1 AND user_id = $2`,
    [params.couponId, params.userId],
    db,
  );
}

export function listCouponsForAdmin(db?: Queryable): Promise<CouponAdminRow[]> {
  return rows<CouponAdminRow>(
    `SELECT c.id, c.name, c.code, c.discount_paise, c.active,
            c.created_at, c.updated_at, c.created_by,
            (count(r.id) FILTER (WHERE r.redeemed_at IS NOT NULL))::int AS redeemed_count,
            (count(r.id) FILTER (WHERE r.redeemed_at IS NULL))::int AS pending_count
       FROM coupons c
       LEFT JOIN coupon_redemptions r ON r.coupon_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC, c.id DESC`,
    [],
    db,
  );
}

export function createCoupon(
  params: { name: string; code: string; discountPaise: number; createdBy: string },
  db?: Queryable,
): Promise<CouponRow | null> {
  return one<CouponRow>(
    `INSERT INTO coupons (name, code, discount_paise, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING ${COUPON_COLUMNS}`,
    [params.name, params.code, params.discountPaise, params.createdBy],
    db,
  );
}

export function updateCoupon(
  params: {
    id: number;
    name: string;
    code: string;
    discountPaise: number;
    active: boolean;
  },
  db?: Queryable,
): Promise<CouponRow | null> {
  return one<CouponRow>(
    `UPDATE coupons
        SET name = $2, code = $3, discount_paise = $4, active = $5, updated_at = now()
      WHERE id = $1
      RETURNING ${COUPON_COLUMNS}`,
    [params.id, params.name, params.code, params.discountPaise, params.active],
    db,
  );
}
