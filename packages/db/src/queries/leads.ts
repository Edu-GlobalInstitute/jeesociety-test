import { one, rows, type Queryable } from '../query.js';

/**
 * The sales CRM.
 *
 * Every student who signs up is a lead; there is no import step and no separate
 * leads table, because the contact details a salesperson needs are already
 * mandatory at registration. `student_profiles.phone` is NOT NULL and UNIQUE,
 * and the email is on the Better Auth `user` row — so a lead list is a join,
 * and a second copy of a phone number would only create the question of which
 * one to ring.
 *
 * `lead_pipeline` holds sales state and nothing else. A student with no row
 * there is a lead in the 'new' stage, expressed by the LEFT JOIN below rather
 * than by back-filling a row for every student who has ever registered.
 */

export type LeadStage = 'new' | 'contacted' | 'interested' | 'not_interested' | 'lost';

export const LEAD_STAGES: readonly LeadStage[] = [
  'new',
  'contacted',
  'interested',
  'not_interested',
  'lost',
] as const;

export interface LeadRow {
  user_id: string;
  name: string | null;
  email: string;
  email_verified: boolean;
  signed_up_at: Date;
  /** From student_profiles. NULL means the student never finished the profile. */
  phone: string | null;
  class: string | null;
  target_year: number | null;
  state: string | null;
  city: string | null;
  school: string | null;
  referral_source: string | null;
  profile_complete: boolean;
  /** Derived from payments, never from the stage. */
  has_paid: boolean;
  paid_at: Date | null;
  amount_paid: number | null;
  stage: LeadStage;
  owner_id: string | null;
  owner_name: string | null;
  lost_reason: string | null;
  next_follow_up_at: Date | null;
  last_contacted_at: Date | null;
  note_count: number;
  providers: string[];
}

export interface LeadFilters {
  /** Matches name, email or phone. */
  search?: string;
  stage?: LeadStage;
  /** 'paid' | 'unpaid' — read from payments, not from the stage. */
  payment?: 'paid' | 'unpaid';
  studentClass?: string;
  targetYear?: number;
  ownerId?: string;
  /** True for leads with no owner, which the board shows as its own column. */
  unassigned?: boolean;
  /** Follow-ups due at or before now. */
  dueOnly?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * The lead list.
 *
 * `has_paid` comes from a payments EXISTS rather than from the pipeline stage,
 * which is why 'paid' is not one of the stages: two places that both claim to
 * know whether a student paid will eventually disagree, and the one holding the
 * money is right. A salesperson can move a lead to 'interested' and the board
 * still shows Paid beside it the moment the webhook lands.
 */
export async function leadBoard(
  filters: LeadFilters = {},
  db?: Queryable,
): Promise<{ leads: LeadRow[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];

  // Admins are staff, not leads. Listing them beside students would put the
  // sales team in its own pipeline.
  where.push(`NOT EXISTS (SELECT 1 FROM admins ad WHERE ad.user_id = u."id")`);

  if (filters.search?.trim()) {
    params.push(`%${filters.search.trim()}%`);
    const i = params.length;
    where.push(`(u."name" ILIKE $${i} OR u."email" ILIKE $${i} OR p.phone ILIKE $${i})`);
  }
  if (filters.stage) {
    params.push(filters.stage);
    where.push(`COALESCE(l.stage, 'new') = $${params.length}`);
  }
  if (filters.payment === 'paid') {
    where.push(`paid.ok`);
  } else if (filters.payment === 'unpaid') {
    where.push(`NOT paid.ok`);
  }
  if (filters.studentClass) {
    params.push(filters.studentClass);
    where.push(`p.class = $${params.length}`);
  }
  if (filters.targetYear) {
    params.push(filters.targetYear);
    where.push(`p.target_year = $${params.length}`);
  }
  if (filters.ownerId) {
    params.push(filters.ownerId);
    where.push(`l.owner_id = $${params.length}`);
  }
  if (filters.unassigned) {
    where.push(`l.owner_id IS NULL`);
  }
  if (filters.dueOnly) {
    where.push(`l.next_follow_up_at IS NOT NULL AND l.next_follow_up_at <= now()`);
  }

  // One FROM clause, used by both the page query and the count, so the total
  // can never describe a different set from the rows.
  const from = `
    FROM "user" u
    LEFT JOIN student_profiles p ON p.user_id = u."id"
    LEFT JOIN lead_pipeline l    ON l.user_id = u."id"
    LEFT JOIN "user" o           ON o."id" = l.owner_id
    CROSS JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1 FROM payments pay
         WHERE pay.user_id = u."id" AND pay.status = 'paid'
      ) AS ok
    ) paid
    WHERE ${where.join(' AND ')}
  `;

  const limit = Math.min(filters.limit ?? 50, 500);
  const offset = filters.offset ?? 0;

  const totalRow = await one<{ n: number }>(
    `SELECT count(*)::int AS n ${from}`,
    params,
    db,
  );

  params.push(limit, offset);
  const leads = await rows<LeadRow>(
    `SELECT
       u."id" AS user_id, u."name", u."email", u."emailVerified" AS email_verified,
       u."createdAt" AS signed_up_at,
       p.phone, p.class, p.target_year, p.state, p.city, p.school,
       p.referral_source,
       COALESCE(p.profile_complete, false) AS profile_complete,
       paid.ok AS has_paid,
       (SELECT max(pay.updated_at) FROM payments pay
         WHERE pay.user_id = u."id" AND pay.status = 'paid') AS paid_at,
       (SELECT sum(pay.amount)::int FROM payments pay
         WHERE pay.user_id = u."id" AND pay.status = 'paid') AS amount_paid,
       COALESCE(l.stage, 'new') AS stage,
       l.owner_id, o."name" AS owner_name, l.lost_reason,
       l.next_follow_up_at, l.last_contacted_at,
       (SELECT count(*)::int FROM lead_notes n WHERE n.user_id = u."id") AS note_count,
       COALESCE((
         SELECT array_agg(DISTINCT a."providerId")
           FROM "account" a WHERE a."userId" = u."id"
       ), ARRAY[]::text[]) AS providers
     ${from}
     -- Due follow-ups first, then the freshest signups: the two things a
     -- salesperson opening this screen is actually looking for.
     ORDER BY
       (l.next_follow_up_at IS NOT NULL AND l.next_follow_up_at <= now()) DESC,
       l.next_follow_up_at ASC NULLS LAST,
       u."createdAt" DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
    db,
  );

  return { leads, total: totalRow?.n ?? 0 };
}

/** One student's full card, including the contact log. */
export async function leadDetail(
  userId: string,
  db?: Queryable,
): Promise<{ lead: LeadRow | null; notes: LeadNoteRow[] }> {
  const notes = await listNotes(userId, db);

  const lead = await one<LeadRow>(
    `SELECT
       u."id" AS user_id, u."name", u."email", u."emailVerified" AS email_verified,
       u."createdAt" AS signed_up_at,
       p.phone, p.class, p.target_year, p.state, p.city, p.school,
       p.referral_source,
       COALESCE(p.profile_complete, false) AS profile_complete,
       EXISTS (SELECT 1 FROM payments pay
                WHERE pay.user_id = u."id" AND pay.status = 'paid') AS has_paid,
       (SELECT max(pay.updated_at) FROM payments pay
         WHERE pay.user_id = u."id" AND pay.status = 'paid') AS paid_at,
       (SELECT sum(pay.amount)::int FROM payments pay
         WHERE pay.user_id = u."id" AND pay.status = 'paid') AS amount_paid,
       COALESCE(l.stage, 'new') AS stage,
       l.owner_id, o."name" AS owner_name, l.lost_reason,
       l.next_follow_up_at, l.last_contacted_at,
       (SELECT count(*)::int FROM lead_notes n WHERE n.user_id = u."id") AS note_count,
       COALESCE((
         SELECT array_agg(DISTINCT a."providerId")
           FROM "account" a WHERE a."userId" = u."id"
       ), ARRAY[]::text[]) AS providers
       FROM "user" u
       LEFT JOIN student_profiles p ON p.user_id = u."id"
       LEFT JOIN lead_pipeline l    ON l.user_id = u."id"
       LEFT JOIN "user" o           ON o."id" = l.owner_id
      WHERE u."id" = $1`,
    [userId],
    db,
  );

  return { lead, notes };
}

export interface LeadNoteRow {
  id: number;
  user_id: string;
  author_id: string;
  author_name: string | null;
  channel: string;
  body: string;
  at: Date;
}

export function listNotes(
  userId: string,
  db?: Queryable,
  limit = 200,
): Promise<LeadNoteRow[]> {
  return rows<LeadNoteRow>(
    `SELECT n.id, n.user_id, n.author_id, a."name" AS author_name,
            n.channel, n.body, n.at
       FROM lead_notes n
       LEFT JOIN "user" a ON a."id" = n.author_id
      WHERE n.user_id = $1
      ORDER BY n.at DESC, n.id DESC
      LIMIT $2`,
    [userId, limit],
    db,
  );
}

export async function addNote(
  params: { userId: string; authorId: string; channel: string; body: string },
  db?: Queryable,
): Promise<LeadNoteRow | null> {
  const note = await one<LeadNoteRow>(
    `INSERT INTO lead_notes (user_id, author_id, channel, body)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, author_id, NULL::text AS author_name, channel, body, at`,
    [params.userId, params.authorId, params.channel, params.body],
    db,
  );

  // A note is a contact, so the card's "last contacted" follows from it rather
  // than needing to be set separately and forgotten. A plain note is not a
  // contact — writing yourself a reminder is not reaching the student.
  if (params.channel !== 'note' && params.channel !== 'stage_change') {
    await rows(
      `INSERT INTO lead_pipeline (user_id, last_contacted_at)
       VALUES ($1, now())
       ON CONFLICT (user_id) DO UPDATE SET last_contacted_at = now()`,
      [params.userId],
      db,
    );
  }

  return note;
}

export interface UpdateLeadParams {
  userId: string;
  stage?: LeadStage;
  ownerId?: string | null;
  lostReason?: string | null;
  nextFollowUpAt?: string | null;
}

/**
 * Sets sales state, creating the pipeline row on first touch.
 *
 * Every field is optional and only the ones provided are written, so assigning
 * an owner does not silently reset a stage someone else just moved. COALESCE on
 * the excluded value against the existing one is what gives that: a NULL in the
 * insert means "not provided" and keeps what is there.
 *
 * Clearing a field therefore needs its own call — `lostReason: null` cannot
 * mean both "leave it" and "clear it". The routes express clearing by writing
 * the empty string, which the route normalises.
 */
export async function updateLead(
  params: UpdateLeadParams,
  db?: Queryable,
): Promise<void> {
  await rows(
    `INSERT INTO lead_pipeline (user_id, stage, owner_id, lost_reason, next_follow_up_at)
     VALUES ($1, COALESCE($2, 'new'), $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       stage             = COALESCE($2, lead_pipeline.stage),
       owner_id          = CASE WHEN $6::boolean THEN $3 ELSE lead_pipeline.owner_id END,
       lost_reason       = CASE WHEN $7::boolean THEN $4 ELSE lead_pipeline.lost_reason END,
       next_follow_up_at = CASE WHEN $8::boolean THEN $5 ELSE lead_pipeline.next_follow_up_at END`,
    [
      params.userId,
      params.stage ?? null,
      params.ownerId ?? null,
      params.lostReason ?? null,
      params.nextFollowUpAt ?? null,
      // Whether each nullable field was named at all, so that "set to NULL" and
      // "do not touch" stay distinguishable.
      params.ownerId !== undefined,
      params.lostReason !== undefined,
      params.nextFollowUpAt !== undefined,
    ],
    db,
  );
}

/** Stage totals for the pipeline header. Includes students with no row. */
export async function stageCounts(
  db?: Queryable,
): Promise<{ stage: LeadStage; count: number }[]> {
  const counts = await rows<{ stage: LeadStage; n: string }>(
    `SELECT COALESCE(l.stage, 'new') AS stage, count(*) AS n
       FROM "user" u
       LEFT JOIN lead_pipeline l ON l.user_id = u."id"
      WHERE NOT EXISTS (SELECT 1 FROM admins ad WHERE ad.user_id = u."id")
      GROUP BY COALESCE(l.stage, 'new')`,
    [],
    db,
  );
  const map = new Map(counts.map((row) => [row.stage, Number(row.n)]));
  return LEAD_STAGES.map((stage) => ({ stage, count: map.get(stage) ?? 0 }));
}

/** The sales team, for the owner dropdown. */
export function listAdmins(
  db?: Queryable,
): Promise<{ user_id: string; name: string | null; email: string }[]> {
  return rows(
    `SELECT a.user_id, u."name", u."email"
       FROM admins a JOIN "user" u ON u."id" = a.user_id
      ORDER BY u."name" NULLS LAST, u."email"`,
    [],
    db,
  );
}
