import express, { Router } from 'express';
import { z } from 'zod';
import { admin, leads, metrics, type Pool } from '@jee/db';
import type { Auth } from '../auth.js';
import { currentUser, requireAdmin } from '../middleware/session.js';
import { notFound } from '../middleware/errors.js';
import { checkPhone } from '../lib/phone.js';

/**
 * The business half of the admin portal: the KPI dashboard and the sales CRM.
 *
 * Separate from routes/admin.ts, which is the event console — live sync health,
 * the review queue, going live. Nothing in this file runs during the test, and
 * keeping them apart means a slow CRM query cannot be mounted on the same
 * router as the dashboard an admin is refreshing while 25,000 students sit the
 * paper.
 *
 * Every route here is behind requireAdmin, which checks a row in `admins` on
 * each request rather than trusting a claim in the session cookie — so removing
 * someone from the sales team takes effect immediately.
 */
export function adminCrmRoutes({
  pool,
  auth,
}: {
  pool: Pool;
  auth: Auth;
}): Router {
  const router = Router();
  router.use(express.json({ limit: '64kb' }));
  router.use(requireAdmin(auth, pool));

  /* ---------------------------------------------------------------------- */
  /* GET /admin/metrics — the dashboard.                                     */
  /* ---------------------------------------------------------------------- */
  /**
   * The KPI tiles and the graph series in one response.
   *
   * One round trip rather than five, because the dashboard shows them together
   * and five requests would let the tiles and the graph disagree: a payment
   * landing between two of them would be counted by one and missed by the
   * other, and the graph would not add up to the tile above it.
   */
  router.get('/metrics', async (_req, res) => {
    const [week, month, series30, funnel, referrals, cohorts, stages] =
      await Promise.all([
        metrics.kpiWindow(7, pool),
        metrics.kpiWindow(30, pool),
        metrics.dailySeries(30, pool),
        metrics.funnelTotals(pool),
        metrics.referralBreakdown(pool),
        metrics.cohortBreakdown(pool),
        leads.stageCounts(pool),
      ]);

    res.json({
      last7Days: week,
      last30Days: month,
      // 30 days of points; the 7-day view is the tail of the same array, so the
      // two charts cannot disagree about a day they share.
      series: series30,
      funnel,
      referrals,
      cohorts,
      stages,
      generatedAt: new Date().toISOString(),
    });
  });

  /* ---------------------------------------------------------------------- */
  /* GET /admin/leads — the CRM list.                                        */
  /* ---------------------------------------------------------------------- */
  const LeadQuerySchema = z.object({
    search: z.string().trim().max(120).optional(),
    stage: z.enum(['new', 'contacted', 'interested', 'not_interested', 'lost']).optional(),
    payment: z.enum(['paid', 'unpaid']).optional(),
    class: z.enum(['11', '12', 'dropper']).optional(),
    targetYear: z.coerce.number().int().min(2024).max(2040).optional(),
    ownerId: z.string().max(64).optional(),
    unassigned: z.coerce.boolean().optional(),
    dueOnly: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  });

  router.get('/leads', async (req, res) => {
    const query = LeadQuerySchema.parse(req.query);
    const { leads: list, total } = await leads.leadBoard(
      {
        search: query.search,
        stage: query.stage,
        payment: query.payment,
        studentClass: query.class,
        targetYear: query.targetYear,
        ownerId: query.ownerId,
        unassigned: query.unassigned,
        dueOnly: query.dueOnly,
        limit: query.limit,
        offset: query.offset,
      },
      pool,
    );

    res.json({
      total,
      limit: query.limit,
      offset: query.offset,
      leads: list.map(serialiseLead),
    });
  });

  /** The owner dropdown: who can be assigned a lead. */
  router.get('/leads/owners', async (_req, res) => {
    const owners = await leads.listAdmins(pool);
    res.json({
      owners: owners.map((row) => ({
        userId: row.user_id,
        name: row.name,
        email: row.email,
      })),
    });
  });

  /**
   * CSV of the current filter, for the team that works the phones off a sheet.
   *
   * Capped at 5,000 rows: this is a sales export, and a request that would
   * stream every student is a report, which belongs in a job rather than in a
   * request an admin is waiting on.
   */
  router.get('/leads/export', async (req, res) => {
    const query = LeadQuerySchema.parse(req.query);
    const { leads: list } = await leads.leadBoard(
      {
        search: query.search,
        stage: query.stage,
        payment: query.payment,
        studentClass: query.class,
        targetYear: query.targetYear,
        ownerId: query.ownerId,
        unassigned: query.unassigned,
        dueOnly: query.dueOnly,
        limit: 5000,
        offset: 0,
      },
      pool,
    );

    const header = [
      'name', 'phone', 'email', 'class', 'target_year', 'state', 'city',
      'school', 'stage', 'paid', 'amount_paid_inr', 'owner', 'referral',
      'signed_up_at', 'last_contacted_at', 'next_follow_up_at',
    ];
    const lines = [header.join(',')];
    for (const lead of list) {
      lines.push(
        [
          lead.name, lead.phone, lead.email, lead.class, lead.target_year,
          lead.state, lead.city, lead.school, lead.stage,
          lead.has_paid ? 'yes' : 'no',
          lead.amount_paid ? lead.amount_paid / 100 : '',
          lead.owner_name, lead.referral_source,
          lead.signed_up_at?.toISOString() ?? '',
          lead.last_contacted_at?.toISOString() ?? '',
          lead.next_follow_up_at?.toISOString() ?? '',
        ].map(csvCell).join(','),
      );
    }

    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader(
      'content-disposition',
      `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(lines.join('\r\n'));
  });

  /** One student's card: profile, payment state and the whole contact log. */
  router.get('/leads/:userId', async (req, res) => {
    const userId = z.string().min(1).max(64).parse(req.params.userId);
    const { lead, notes } = await leads.leadDetail(userId, pool);
    if (!lead) throw notFound('no_lead', 'No such student.');

    res.json({
      lead: serialiseLead(lead),
      notes: notes.map((note) => ({
        id: note.id,
        channel: note.channel,
        body: note.body,
        author: note.author_name,
        at: note.at.toISOString(),
      })),
    });
  });

  /* ---------------------------------------------------------------------- */
  /* POST /admin/leads/:userId — stage, owner, follow-up.                    */
  /* ---------------------------------------------------------------------- */
  /**
   * `null` clears a field and omitting it leaves the field alone, which is why
   * `.nullable().optional()` rather than `.optional()`: assigning an owner must
   * not reset a stage a colleague changed a second earlier.
   */
  const UpdateLeadSchema = z.object({
    stage: z
      .enum(['new', 'contacted', 'interested', 'not_interested', 'lost'])
      .optional(),
    ownerId: z.string().max(64).nullable().optional(),
    lostReason: z.string().max(500).nullable().optional(),
    nextFollowUpAt: z.string().datetime().nullable().optional(),
  });

  router.post('/leads/:userId', async (req, res) => {
    const me = currentUser(req);
    const userId = z.string().min(1).max(64).parse(req.params.userId);
    const body = UpdateLeadSchema.parse(req.body);

    const { lead } = await leads.leadDetail(userId, pool);
    if (!lead) throw notFound('no_lead', 'No such student.');

    await leads.updateLead(
      {
        userId,
        stage: body.stage,
        ...(body.ownerId !== undefined ? { ownerId: body.ownerId } : {}),
        ...(body.lostReason !== undefined ? { lostReason: body.lostReason } : {}),
        ...(body.nextFollowUpAt !== undefined
          ? { nextFollowUpAt: body.nextFollowUpAt }
          : {}),
      },
      pool,
    );

    // A stage change is written into the log as well as onto the row. The row
    // says where the lead is now; the log is the only thing that can say it was
    // moved to 'lost' by someone on a Tuesday and why.
    if (body.stage && body.stage !== lead.stage) {
      await leads.addNote(
        {
          userId,
          authorId: me.id,
          channel: 'stage_change',
          body:
            `Stage: ${lead.stage} → ${body.stage}`
            + (body.lostReason ? ` (${body.lostReason})` : ''),
        },
        pool,
      );
    }

    res.json({ ok: true });
  });

  /* ---------------------------------------------------------------------- */
  /* POST /admin/leads/:userId/notes — the contact log.                      */
  /* ---------------------------------------------------------------------- */
  const NoteSchema = z.object({
    channel: z.enum(['note', 'call', 'whatsapp', 'email', 'sms']).default('note'),
    body: z.string().trim().min(1).max(4000),
  });

  router.post('/leads/:userId/notes', async (req, res) => {
    const me = currentUser(req);
    const userId = z.string().min(1).max(64).parse(req.params.userId);
    const body = NoteSchema.parse(req.body);

    const { lead } = await leads.leadDetail(userId, pool);
    if (!lead) throw notFound('no_lead', 'No such student.');

    const note = await leads.addNote(
      { userId, authorId: me.id, channel: body.channel, body: body.body },
      pool,
    );

    res.json({
      ok: true,
      note: note
        ? { id: note.id, channel: note.channel, body: note.body, at: note.at.toISOString() }
        : null,
    });
  });

  /* ---------------------------------------------------------------------- */
  /* POST /admin/leads/bulk — stage or owner across a selection.             */
  /* ---------------------------------------------------------------------- */
  /**
   * Capped at 500 ids. A bulk action over every student is a campaign, not an
   * edit, and it would hold a request open long enough to time out behind
   * Render's proxy — leaving an admin unsure how many of the writes landed.
   */
  const BulkSchema = z.object({
    userIds: z.array(z.string().min(1).max(64)).min(1).max(500),
    stage: z
      .enum(['new', 'contacted', 'interested', 'not_interested', 'lost'])
      .optional(),
    ownerId: z.string().max(64).nullable().optional(),
  });

  router.post('/leads/bulk', async (req, res) => {
    const me = currentUser(req);
    const body = BulkSchema.parse(req.body);

    // One transaction: a half-applied bulk assignment is worse than a failed
    // one, because nobody can tell which half.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const userId of body.userIds) {
        await leads.updateLead(
          {
            userId,
            stage: body.stage,
            ...(body.ownerId !== undefined ? { ownerId: body.ownerId } : {}),
          },
          client,
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    await admin.logAdminAction(
      {
        adminId: me.id,
        action: 'leads_bulk_update',
        attemptId: null,
        questionId: null,
        before: null,
        after: { count: body.userIds.length, stage: body.stage ?? null },
        reason: 'bulk edit from the CRM',
      },
      pool,
    );

    res.json({ ok: true, updated: body.userIds.length });
  });

  return router;
}

/**
 * The lead shape the CRM renders.
 *
 * `phoneE164` is built here rather than stored: the column holds the ten digits
 * the student typed, and a tel: link needs the country code. Deriving it keeps
 * one canonical number in the database and the UNIQUE index meaningful.
 */
function serialiseLead(lead: {
  user_id: string;
  name: string | null;
  email: string;
  email_verified: boolean;
  signed_up_at: Date;
  phone: string | null;
  class: string | null;
  target_year: number | null;
  state: string | null;
  city: string | null;
  school: string | null;
  referral_source: string | null;
  profile_complete: boolean;
  has_paid: boolean;
  paid_at: Date | null;
  amount_paid: number | null;
  stage: string;
  owner_id: string | null;
  owner_name: string | null;
  lost_reason: string | null;
  next_follow_up_at: Date | null;
  last_contacted_at: Date | null;
  note_count: number;
  providers: string[];
}) {
  const checked = lead.phone ? checkPhone(lead.phone) : null;
  return {
    userId: lead.user_id,
    name: lead.name,
    email: lead.email,
    emailVerified: lead.email_verified,
    signedUpAt: lead.signed_up_at?.toISOString() ?? null,
    phone: lead.phone,
    phoneE164: checked?.ok ? `+91${checked.phone}` : null,
    class: lead.class,
    targetYear: lead.target_year,
    state: lead.state,
    city: lead.city,
    school: lead.school,
    referralSource: lead.referral_source,
    profileComplete: lead.profile_complete,
    hasPaid: lead.has_paid,
    paidAt: lead.paid_at?.toISOString() ?? null,
    amountPaidPaise: lead.amount_paid,
    stage: lead.stage,
    ownerId: lead.owner_id,
    ownerName: lead.owner_name,
    lostReason: lead.lost_reason,
    nextFollowUpAt: lead.next_follow_up_at?.toISOString() ?? null,
    lastContactedAt: lead.last_contacted_at?.toISOString() ?? null,
    noteCount: lead.note_count,
    providers: lead.providers,
  };
}

/** RFC 4180: quote when the value contains a comma, quote or newline. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}
