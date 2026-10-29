import { one, rows, type Queryable } from '../query.js';

/**
 * Business metrics for the admin dashboard: signups, paid conversions and the
 * daily series behind the comparison graph.
 *
 * Distinct from queries/admin.ts, which answers "is the event healthy right
 * now" during the test. Nothing here runs during the event.
 *
 * Two conventions hold throughout, and both exist because the numbers are read
 * by people who will act on them:
 *
 *   Days are IST days. `now() - interval '7 days'` would cut the series at
 *   whatever time of day it happens to be, so "last 7 days" would mean a
 *   different span each time the page is opened and today's bar would always
 *   look short. Every bucket here is a calendar day in Asia/Kolkata.
 *
 *   A paid conversion is dated by when the money arrived, not by when the
 *   student signed up. A student who registered in September and paid today is
 *   today's conversion — that is what a sales dashboard is for. The funnel
 *   percentage is therefore not a cohort figure and is not presented as one.
 */

/** A calendar day in IST. */
const IST = `'Asia/Kolkata'`;

export interface KpiWindow {
  days: number;
  signups: number;
  paid: number;
  revenuePaise: number;
  /** Same-length window immediately before this one, for the trend arrow. */
  previousSignups: number;
  previousPaid: number;
  previousRevenuePaise: number;
}

/**
 * Signups, conversions and revenue over the last `days` IST days, with the
 * preceding equal window beside them.
 *
 * The comparison window is what makes the number mean anything: "412 signups"
 * is not information, "412, up from 260" is. Both windows end at the start of
 * their last day boundary the same way, so they are the same length.
 */
export async function kpiWindow(days: number, db?: Queryable): Promise<KpiWindow> {
  const row = await one<Record<string, string>>(
    `WITH bounds AS (
       SELECT
         -- Midnight IST, days-1 back, so the window includes today.
         (date_trunc('day', now() AT TIME ZONE ${IST})
            - make_interval(days => $1::int - 1)) AT TIME ZONE ${IST} AS this_start,
         (date_trunc('day', now() AT TIME ZONE ${IST})
            - make_interval(days => $1::int * 2 - 1)) AT TIME ZONE ${IST} AS prev_start
     )
     SELECT
       (SELECT count(*) FROM "user" u, bounds b
         WHERE u."createdAt" >= b.this_start) AS signups,
       (SELECT count(*) FROM "user" u, bounds b
         WHERE u."createdAt" >= b.prev_start AND u."createdAt" < b.this_start)
         AS prev_signups,
       (SELECT count(DISTINCT p.user_id) FROM payments p, bounds b
         WHERE p.status = 'paid' AND p.updated_at >= b.this_start) AS paid,
       (SELECT count(DISTINCT p.user_id) FROM payments p, bounds b
         WHERE p.status = 'paid'
           AND p.updated_at >= b.prev_start AND p.updated_at < b.this_start)
         AS prev_paid,
       (SELECT COALESCE(sum(p.amount), 0) FROM payments p, bounds b
         WHERE p.status = 'paid' AND p.updated_at >= b.this_start) AS revenue,
       (SELECT COALESCE(sum(p.amount), 0) FROM payments p, bounds b
         WHERE p.status = 'paid'
           AND p.updated_at >= b.prev_start AND p.updated_at < b.this_start)
         AS prev_revenue`,
    [days],
    db,
  );

  return {
    days,
    signups: Number(row?.signups ?? 0),
    paid: Number(row?.paid ?? 0),
    revenuePaise: Number(row?.revenue ?? 0),
    previousSignups: Number(row?.prev_signups ?? 0),
    previousPaid: Number(row?.prev_paid ?? 0),
    previousRevenuePaise: Number(row?.prev_revenue ?? 0),
  };
}

export interface DailyPoint {
  /** YYYY-MM-DD, an IST calendar day. */
  day: string;
  signups: number;
  paid: number;
  revenuePaise: number;
}

/**
 * The daily series behind the signup-versus-paid graph.
 *
 * Generated from a date series and LEFT JOINed, so a day on which nobody
 * registered appears as a zero rather than being missing. A line chart that
 * silently closes the gap over an empty day draws a slope that did not happen.
 */
export async function dailySeries(days: number, db?: Queryable): Promise<DailyPoint[]> {
  return rows<DailyPoint>(
    `WITH days AS (
       SELECT generate_series(
         date_trunc('day', now() AT TIME ZONE ${IST})
           - make_interval(days => $1::int - 1),
         date_trunc('day', now() AT TIME ZONE ${IST}),
         interval '1 day'
       )::date AS day
     )
     SELECT
       to_char(d.day, 'YYYY-MM-DD') AS day,
       COALESCE(s.n, 0)::int AS signups,
       COALESCE(p.n, 0)::int AS paid,
       COALESCE(p.amount, 0)::bigint AS "revenuePaise"
     FROM days d
     LEFT JOIN (
       SELECT (u."createdAt" AT TIME ZONE ${IST})::date AS day, count(*) AS n
         FROM "user" u GROUP BY 1
     ) s ON s.day = d.day
     LEFT JOIN (
       SELECT (pay.updated_at AT TIME ZONE ${IST})::date AS day,
              count(DISTINCT pay.user_id) AS n,
              sum(pay.amount) AS amount
         FROM payments pay WHERE pay.status = 'paid' GROUP BY 1
     ) p ON p.day = d.day
     ORDER BY d.day`,
    [days],
    db,
  );
}

export interface FunnelTotals {
  signups: number;
  profilesComplete: number;
  ordersCreated: number;
  paid: number;
  /** Orders created that never reached 'paid'. The number worth chasing. */
  abandoned: number;
}

/**
 * The all-time funnel.
 *
 * `abandoned` counts students with an order and no payment — a student who
 * reached Razorpay and did not finish. They are the warmest leads in the
 * system, and before this dashboard existed there was no screen that showed
 * them at all.
 */
export async function funnelTotals(db?: Queryable): Promise<FunnelTotals> {
  const row = await one<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM "user" u
         WHERE NOT EXISTS (SELECT 1 FROM admins a WHERE a.user_id = u."id")) AS signups,
       (SELECT count(*) FROM student_profiles WHERE profile_complete) AS profiles,
       (SELECT count(DISTINCT user_id) FROM payments) AS orders,
       (SELECT count(DISTINCT user_id) FROM payments WHERE status = 'paid') AS paid,
       (SELECT count(DISTINCT p.user_id) FROM payments p
         WHERE NOT EXISTS (
           SELECT 1 FROM payments q
            WHERE q.user_id = p.user_id AND q.status = 'paid'
         )) AS abandoned`,
    [],
    db,
  );
  return {
    signups: Number(row?.signups ?? 0),
    profilesComplete: Number(row?.profiles ?? 0),
    ordersCreated: Number(row?.orders ?? 0),
    paid: Number(row?.paid ?? 0),
    abandoned: Number(row?.abandoned ?? 0),
  };
}

/** Where students say they heard about the test. Drives spend decisions. */
export function referralBreakdown(
  db?: Queryable,
): Promise<{ source: string; signups: number; paid: number }[]> {
  return rows(
    `SELECT COALESCE(p.referral_source, 'unknown') AS source,
            count(*)::int AS signups,
            count(*) FILTER (
              WHERE EXISTS (SELECT 1 FROM payments pay
                             WHERE pay.user_id = p.user_id AND pay.status = 'paid')
            )::int AS paid
       FROM student_profiles p
      GROUP BY 1
      ORDER BY signups DESC`,
    [],
    db,
  );
}

/** Class and target-year mix, for the CRM header. */
export function cohortBreakdown(
  db?: Queryable,
): Promise<{ class: string; target_year: number; signups: number; paid: number }[]> {
  return rows(
    `SELECT p.class, p.target_year,
            count(*)::int AS signups,
            count(*) FILTER (
              WHERE EXISTS (SELECT 1 FROM payments pay
                             WHERE pay.user_id = p.user_id AND pay.status = 'paid')
            )::int AS paid
       FROM student_profiles p
      GROUP BY p.class, p.target_year
      ORDER BY p.target_year, p.class`,
    [],
    db,
  );
}
