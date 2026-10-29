'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../../lib/api';

/**
 * The sales CRM.
 *
 * Built around the two things a salesperson actually does: find the next person
 * to call, and record what happened when they did. So the phone number is a
 * `tel:` link and the WhatsApp number a `wa.me` link — on a phone, which is
 * where this is read, tapping is the whole interaction — and every lead opens a
 * drawer with the contact log rather than a separate page.
 *
 * Due follow-ups sort to the top, ahead of the newest signups. That ordering is
 * the server's (see leadBoard) and it is the one thing on this screen that is
 * not a filter: the list should already be the list.
 */

interface Lead {
  userId: string;
  name: string | null;
  email: string;
  emailVerified: boolean;
  signedUpAt: string | null;
  phone: string | null;
  phoneE164: string | null;
  class: string | null;
  targetYear: number | null;
  state: string | null;
  city: string | null;
  school: string | null;
  referralSource: string | null;
  profileComplete: boolean;
  hasPaid: boolean;
  paidAt: string | null;
  amountPaidPaise: number | null;
  stage: string;
  ownerId: string | null;
  ownerName: string | null;
  lostReason: string | null;
  nextFollowUpAt: string | null;
  lastContactedAt: string | null;
  noteCount: number;
  providers: string[];
}

interface Note {
  id: number;
  channel: string;
  body: string;
  author: string | null;
  at: string;
}

const STAGES = ['new', 'contacted', 'interested', 'not_interested', 'lost'] as const;
const STAGE_LABELS: Record<string, string> = {
  new: 'New',
  contacted: 'Contacted',
  interested: 'Interested',
  not_interested: 'Not interested',
  lost: 'Lost',
};
const CHANNELS = ['call', 'whatsapp', 'email', 'sms', 'note'] as const;

const PAGE = 50;

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [owners, setOwners] = useState<{ userId: string; name: string | null; email: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('');
  const [payment, setPayment] = useState('');
  const [studentClass, setStudentClass] = useState('');
  const [owner, setOwner] = useState('');
  const [dueOnly, setDueOnly] = useState(false);

  /** The filters, as a query string. Also what the CSV export is given. */
  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    if (stage) params.set('stage', stage);
    if (payment) params.set('payment', payment);
    if (studentClass) params.set('class', studentClass);
    if (owner === 'unassigned') params.set('unassigned', 'true');
    else if (owner) params.set('ownerId', owner);
    if (dueOnly) params.set('dueOnly', 'true');
    return params;
  }, [search, stage, payment, studentClass, owner, dueOnly]);

  const load = useCallback(
    (nextOffset: number) => {
      setBusy(true);
      const params = new URLSearchParams(query);
      params.set('limit', String(PAGE));
      params.set('offset', String(nextOffset));
      api<{ leads: Lead[]; total: number }>(`/admin/leads?${params}`)
        .then((next) => {
          setLeads(next.leads);
          setTotal(next.total);
          setOffset(nextOffset);
          setError(null);
        })
        .catch(() => setError('Could not load leads. Admin access is required.'))
        .finally(() => setBusy(false));
    },
    [query],
  );

  // On mount, read the filters out of the URL so the dashboard can link
  // straight to a slice ("work that list").
  useEffect(() => {
    const url = new URLSearchParams(window.location.search);
    if (url.get('stage')) setStage(url.get('stage')!);
    if (url.get('payment')) setPayment(url.get('payment')!);
    if (url.get('dueOnly')) setDueOnly(true);
    api<{ owners: typeof owners }>('/admin/leads/owners')
      .then((next) => setOwners(next.owners))
      .catch(() => {});
  }, []);

  // Debounced, because this fires on every keystroke in the search box and each
  // one is a filtered scan over every student.
  useEffect(() => {
    const timer = setTimeout(() => load(0), 250);
    return () => clearTimeout(timer);
  }, [load]);

  async function bulk(patch: { stage?: string; ownerId?: string | null }) {
    if (selected.size === 0) return;
    try {
      await api('/admin/leads/bulk', {
        method: 'POST',
        body: JSON.stringify({ userIds: [...selected], ...patch }),
      });
      setSelected(new Set());
      load(offset);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Bulk update failed.');
    }
  }

  const exportUrl = `${process.env.NEXT_PUBLIC_API_URL ?? ''}/admin/leads/export?${query}`;

  return (
    <main className="ap">
      <div className="ap__head">
        <div>
          <h1>Sales CRM</h1>
          <p className="ap__sub">
            {total.toLocaleString('en-IN')} student{total === 1 ? '' : 's'}
            {query.toString() ? ' matching these filters' : ''} · due follow-ups first
          </p>
        </div>
        <div className="row">
          {/* A plain link, not fetch: the browser downloads it with the session
              cookie attached, so there is no blob to build or revoke. */}
          <a className="btn" href={exportUrl}>
            Export CSV
          </a>
        </div>
      </div>

      {error ? <p className="msg msg--bad">{error}</p> : null}

      {/* Filters in one row above the table. */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row">
          <input
            className="inp inp--sm"
            style={{ flex: '2 1 220px', width: 'auto' }}
            placeholder="Name, phone or email…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select className="sel sel--sm" style={{ width: 'auto' }} value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">Any stage</option>
            {STAGES.map((value) => (
              <option key={value} value={value}>
                {STAGE_LABELS[value]}
              </option>
            ))}
          </select>
          <select className="sel sel--sm" style={{ width: 'auto' }} value={payment} onChange={(e) => setPayment(e.target.value)}>
            <option value="">Paid or not</option>
            <option value="paid">Paid</option>
            <option value="unpaid">Not paid</option>
          </select>
          <select
            className="sel sel--sm"
            style={{ width: 'auto' }}
            value={studentClass}
            onChange={(e) => setStudentClass(e.target.value)}
          >
            <option value="">Any class</option>
            <option value="11">Class 11</option>
            <option value="12">Class 12</option>
            <option value="dropper">Dropper</option>
          </select>
          <select className="sel sel--sm" style={{ width: 'auto' }} value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Anyone</option>
            <option value="unassigned">Unassigned</option>
            {owners.map((row) => (
              <option key={row.userId} value={row.userId}>
                {row.name ?? row.email}
              </option>
            ))}
          </select>
          <label className="row" style={{ gap: 5, fontSize: '0.82rem', fontWeight: 600 }}>
            <input type="checkbox" checked={dueOnly} onChange={(e) => setDueOnly(e.target.checked)} />
            Due now
          </label>
        </div>
      </div>

      {selected.size > 0 ? (
        <div className="msg msg--warn">
          <div className="row">
            <strong>{selected.size} selected</strong>
            <select
              className="sel sel--sm"
              style={{ width: 'auto' }}
              defaultValue=""
              onChange={(event) => {
                if (event.target.value) void bulk({ stage: event.target.value });
                event.target.value = '';
              }}
            >
              <option value="">Move to stage…</option>
              {STAGES.map((value) => (
                <option key={value} value={value}>
                  {STAGE_LABELS[value]}
                </option>
              ))}
            </select>
            <select
              className="sel sel--sm"
              style={{ width: 'auto' }}
              defaultValue=""
              onChange={(event) => {
                if (event.target.value) {
                  void bulk({ ownerId: event.target.value === 'none' ? null : event.target.value });
                }
                event.target.value = '';
              }}
            >
              <option value="">Assign to…</option>
              <option value="none">Nobody</option>
              {owners.map((row) => (
                <option key={row.userId} value={row.userId}>
                  {row.name ?? row.email}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn--sm" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        </div>
      ) : null}

      <div className="tablewrap">
        <table className="t">
          <thead>
            <tr>
              <th style={{ width: 30 }}>
                <input
                  type="checkbox"
                  checked={leads.length > 0 && selected.size === leads.length}
                  onChange={(event) =>
                    setSelected(event.target.checked ? new Set(leads.map((l) => l.userId)) : new Set())
                  }
                  aria-label="Select all on this page"
                />
              </th>
              <th>Student</th>
              <th>Phone</th>
              <th>Class</th>
              <th>Stage</th>
              <th>Payment</th>
              <th>Owner</th>
              <th>Follow-up</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {leads.length === 0 && !busy ? (
              <tr>
                <td colSpan={9}>
                  <p className="empty">No students match these filters.</p>
                </td>
              </tr>
            ) : null}
            {leads.map((lead) => (
              <tr key={lead.userId}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(lead.userId)}
                    onChange={(event) => {
                      const next = new Set(selected);
                      if (event.target.checked) next.add(lead.userId);
                      else next.delete(lead.userId);
                      setSelected(next);
                    }}
                    aria-label={`Select ${lead.name ?? lead.email}`}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    onClick={() => setOpen(lead.userId)}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      font: 'inherit',
                      fontWeight: 600,
                      color: 'var(--orange-deep)',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    {lead.name ?? '(no name)'}
                  </button>
                  <div className="muted-cell" style={{ fontSize: '0.76rem' }}>
                    {lead.email}
                  </div>
                </td>
                <td className="nowrap">
                  {lead.phoneE164 ? (
                    <>
                      <a href={`tel:${lead.phoneE164}`} className="tnum">
                        {lead.phone}
                      </a>{' '}
                      <a
                        href={`https://wa.me/${lead.phoneE164.replace('+', '')}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="WhatsApp"
                        style={{ textDecoration: 'none' }}
                      >
                        ↗
                      </a>
                    </>
                  ) : (
                    <span className="chip chip--warn">no profile</span>
                  )}
                </td>
                <td className="nowrap">
                  {lead.class === 'dropper' ? 'Dropper' : lead.class ? `Class ${lead.class}` : '—'}
                  {lead.targetYear ? (
                    <div className="muted-cell tnum" style={{ fontSize: '0.76rem' }}>
                      → {lead.targetYear}
                    </div>
                  ) : null}
                </td>
                <td>
                  <StageSelect
                    lead={lead}
                    onChanged={() => load(offset)}
                    onError={setError}
                  />
                </td>
                <td className="nowrap">
                  {lead.hasPaid ? (
                    <span className="chip chip--paid">
                      ₹{((lead.amountPaidPaise ?? 0) / 100).toLocaleString('en-IN')}
                    </span>
                  ) : (
                    <span className="chip chip--unpaid">unpaid</span>
                  )}
                </td>
                <td className="nowrap muted-cell">{lead.ownerName ?? '—'}</td>
                <td className="nowrap">
                  {lead.nextFollowUpAt ? (
                    <span
                      className={
                        new Date(lead.nextFollowUpAt) <= new Date() ? 'chip chip--bad' : 'chip chip--unpaid'
                      }
                    >
                      {new Date(lead.nextFollowUpAt).toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                      })}
                    </span>
                  ) : (
                    <span className="muted-cell">—</span>
                  )}
                </td>
                <td className="nowrap">
                  <button type="button" className="btn btn--sm" onClick={() => setOpen(lead.userId)}>
                    {lead.noteCount > 0 ? `${lead.noteCount} ✎` : 'Open'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {total > PAGE ? (
        <div className="row" style={{ marginTop: 12, justifyContent: 'center' }}>
          <button type="button" className="btn" disabled={offset === 0 || busy} onClick={() => load(Math.max(0, offset - PAGE))}>
            ← Previous
          </button>
          <span className="muted-cell tnum">
            {offset + 1}–{Math.min(offset + PAGE, total)} of {total.toLocaleString('en-IN')}
          </span>
          <button
            type="button"
            className="btn"
            disabled={offset + PAGE >= total || busy}
            onClick={() => load(offset + PAGE)}
          >
            Next →
          </button>
        </div>
      ) : null}

      {open ? (
        <LeadDrawer
          userId={open}
          owners={owners}
          onClose={() => setOpen(null)}
          onChanged={() => load(offset)}
        />
      ) : null}
    </main>
  );
}

/** Inline stage change, so moving a lead along is one click in the list. */
function StageSelect({
  lead,
  onChanged,
  onError,
}: {
  lead: Lead;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <select
      className="sel sel--sm"
      style={{ width: 'auto', minWidth: 118 }}
      value={lead.stage}
      disabled={busy}
      onChange={async (event) => {
        const next = event.target.value;
        // 'lost' without a reason is a dead end nobody can learn from, so it is
        // the one stage that asks.
        let lostReason: string | null = null;
        if (next === 'lost') {
          lostReason = window.prompt('Why was this lead lost? (fees, another course, no answer…)');
          if (!lostReason?.trim()) return;
        }
        setBusy(true);
        try {
          await api(`/admin/leads/${lead.userId}`, {
            method: 'POST',
            body: JSON.stringify({ stage: next, ...(lostReason ? { lostReason: lostReason.trim() } : {}) }),
          });
          onChanged();
        } catch (caught) {
          onError(caught instanceof Error ? caught.message : 'Could not change the stage.');
        } finally {
          setBusy(false);
        }
      }}
    >
      {STAGES.map((value) => (
        <option key={value} value={value}>
          {STAGE_LABELS[value]}
        </option>
      ))}
    </select>
  );
}

/** One student's card: everything known about them, and the contact log. */
function LeadDrawer({
  userId,
  owners,
  onClose,
  onChanged,
}: {
  userId: string;
  owners: { userId: string; name: string | null; email: string }[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [lead, setLead] = useState<Lead | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [body, setBody] = useState('');
  const [channel, setChannel] = useState<string>('call');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ lead: Lead; notes: Note[] }>(`/admin/leads/${userId}`)
      .then((next) => {
        setLead(next.lead);
        setNotes(next.notes);
      })
      .catch(() => setError('Could not load this student.'));
  }, [userId]);

  useEffect(load, [load]);

  async function addNote() {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await api(`/admin/leads/${userId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ channel, body: body.trim() }),
      });
      setBody('');
      load();
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save that note.');
    } finally {
      setBusy(false);
    }
  }

  async function patch(update: Record<string, unknown>) {
    try {
      await api(`/admin/leads/${userId}`, { method: 'POST', body: JSON.stringify(update) });
      load();
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save that.');
    }
  }

  return (
    // Click-through on the backdrop only, so a stray click inside the panel
    // does not discard a half-typed note.
    <div className="drawer" onClick={onClose}>
      <div className="drawer__panel" onClick={(event) => event.stopPropagation()}>
        <div className="drawer__head">
          <div>
            <h2 style={{ margin: 0, fontSize: '1.1rem' }}>{lead?.name ?? 'Student'}</h2>
            <p className="ap__sub" style={{ margin: 0 }}>
              {lead?.email}
            </p>
          </div>
          <button type="button" className="btn btn--sm" onClick={onClose}>
            Close
          </button>
        </div>

        {error ? <p className="msg msg--bad">{error}</p> : null}
        {!lead ? (
          <p className="empty">Loading…</p>
        ) : (
          <>
            <section className="card" style={{ marginBottom: 12 }}>
              <h2>Contact</h2>
              <dl className="dl">
                <dt>Phone</dt>
                <dd>
                  {lead.phoneE164 ? (
                    <div className="row">
                      <a href={`tel:${lead.phoneE164}`} className="tnum">
                        {lead.phone}
                      </a>
                      <a
                        className="btn btn--sm"
                        href={`https://wa.me/${lead.phoneE164.replace('+', '')}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        WhatsApp
                      </a>
                    </div>
                  ) : (
                    <span className="chip chip--warn">profile not completed</span>
                  )}
                </dd>
                <dt>Email</dt>
                <dd>
                  <a href={`mailto:${lead.email}`}>{lead.email}</a>{' '}
                  {lead.emailVerified ? null : <span className="chip chip--warn">unverified</span>}
                </dd>
                <dt>Class</dt>
                <dd>
                  {lead.class === 'dropper' ? 'Dropper' : lead.class ? `Class ${lead.class}` : '—'}
                  {lead.targetYear ? ` · targeting ${lead.targetYear}` : ''}
                </dd>
                <dt>Where</dt>
                <dd>{[lead.city, lead.state].filter(Boolean).join(', ') || '—'}</dd>
                <dt>School</dt>
                <dd>{lead.school ?? '—'}</dd>
                <dt>Heard via</dt>
                <dd>{lead.referralSource?.replace(/_/g, ' ') ?? '—'}</dd>
                <dt>Signed up</dt>
                <dd>
                  {lead.signedUpAt ? new Date(lead.signedUpAt).toLocaleString('en-IN') : '—'}
                  {lead.providers.includes('google') ? ' · Google' : ''}
                </dd>
                <dt>Payment</dt>
                <dd>
                  {lead.hasPaid ? (
                    <span className="chip chip--paid">
                      ₹{((lead.amountPaidPaise ?? 0) / 100).toLocaleString('en-IN')} on{' '}
                      {lead.paidAt ? new Date(lead.paidAt).toLocaleDateString('en-IN') : '—'}
                    </span>
                  ) : (
                    <span className="chip chip--unpaid">not paid</span>
                  )}
                </dd>
              </dl>
            </section>

            <section className="card" style={{ marginBottom: 12 }}>
              <h2>Pipeline</h2>
              <label className="field">
                <span>Owner</span>
                <select
                  className="sel"
                  value={lead.ownerId ?? ''}
                  onChange={(event) => patch({ ownerId: event.target.value || null })}
                >
                  <option value="">Unassigned</option>
                  {owners.map((row) => (
                    <option key={row.userId} value={row.userId}>
                      {row.name ?? row.email}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Next follow-up</span>
                <input
                  className="inp"
                  type="date"
                  value={lead.nextFollowUpAt ? lead.nextFollowUpAt.slice(0, 10) : ''}
                  onChange={(event) =>
                    patch({
                      nextFollowUpAt: event.target.value
                        ? new Date(`${event.target.value}T09:00:00+05:30`).toISOString()
                        : null,
                    })
                  }
                />
              </label>
              {lead.lostReason ? (
                <p className="ap__sub" style={{ margin: 0 }}>
                  Lost: {lead.lostReason}
                </p>
              ) : null}
            </section>

            <section className="card">
              <h2>Contact log</h2>
              <div className="row" style={{ marginBottom: 8 }}>
                {CHANNELS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={channel === value ? 'btn btn--sm btn--go' : 'btn btn--sm'}
                    onClick={() => setChannel(value)}
                  >
                    {value}
                  </button>
                ))}
              </div>
              <textarea
                className="ta"
                placeholder="What happened? Asked to call after boards, father wants the syllabus…"
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
              <div className="row" style={{ marginTop: 8 }}>
                <button type="button" className="btn btn--go" disabled={busy || !body.trim()} onClick={addNote}>
                  Save to log
                </button>
                <span className="ap__sub">The log cannot be edited afterwards.</span>
              </div>

              <ul className="log" style={{ marginTop: 14 }}>
                {notes.length === 0 ? <p className="empty">Nothing logged yet.</p> : null}
                {notes.map((note) => (
                  <li key={note.id}>
                    <div className="log__meta">
                      <strong>{note.channel}</strong>
                      <span>{new Date(note.at).toLocaleString('en-IN')}</span>
                      {note.author ? <span>· {note.author}</span> : null}
                    </div>
                    <div className="log__body">{note.body}</div>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
