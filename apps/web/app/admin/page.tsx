'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { SignupPaidChart, type DayPoint } from '../../components/SignupPaidChart';

/**
 * The business dashboard: signups, paid conversions and where both are going.
 *
 * This replaced the live event console on `/admin`, which now lives at
 * `/admin/live`. The reason is how often each is read: the console matters for
 * three hours on one morning, and this is the screen the team opens every day.
 *
 * Every KPI carries the preceding equal window beside it, because a bare number
 * is not information — "412 signups" says nothing that "412, up from 260" does
 * not say better.
 */

interface KpiWindow {
  days: number;
  signups: number;
  paid: number;
  revenuePaise: number;
  previousSignups: number;
  previousPaid: number;
  previousRevenuePaise: number;
}

interface Metrics {
  last7Days: KpiWindow;
  last30Days: KpiWindow;
  series: DayPoint[];
  funnel: {
    signups: number;
    profilesComplete: number;
    ordersCreated: number;
    paid: number;
    abandoned: number;
  };
  referrals: { source: string; signups: number; paid: number }[];
  cohorts: { class: string; target_year: number; signups: number; paid: number }[];
  stages: { stage: string; count: number }[];
  generatedAt: string;
}

const STAGE_LABELS: Record<string, string> = {
  new: 'New',
  contacted: 'Contacted',
  interested: 'Interested',
  not_interested: 'Not interested',
  lost: 'Lost',
};

export default function AdminDashboard() {
  const [data, setData] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<7 | 30>(30);

  useEffect(() => {
    api<Metrics>('/admin/metrics')
      .then((next) => {
        setData(next);
        setError(null);
      })
      .catch((caught) =>
        setError(
          caught instanceof Error && 'status' in caught && (caught as { status: number }).status === 403
            ? 'Admin access is required. Ask for your account to be added to the admins table.'
            : 'Could not load the dashboard.',
        ),
      );
  }, []);

  if (error) {
    return (
      <main className="ap">
        <p className="msg msg--bad">{error}</p>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="ap">
        <p className="empty">Loading…</p>
      </main>
    );
  }

  const window = range === 7 ? data.last7Days : data.last30Days;
  // The 7-day view is the tail of the same 30 points, so the chart and the
  // tiles can never disagree about a day they share.
  const series = range === 7 ? data.series.slice(-7) : data.series;

  const conversion = window.signups > 0 ? (window.paid / window.signups) * 100 : 0;

  return (
    <main className="ap">
      <div className="ap__head">
        <div>
          <h1>Dashboard</h1>
          <p className="ap__sub">
            Updated {new Date(data.generatedAt).toLocaleTimeString('en-IN')} ·{' '}
            <a href="/admin/live">live event console</a>
          </p>
        </div>
        <div className="row">
          <button
            type="button"
            className={range === 7 ? 'btn btn--sm btn--go' : 'btn btn--sm'}
            onClick={() => setRange(7)}
          >
            7 days
          </button>
          <button
            type="button"
            className={range === 30 ? 'btn btn--sm btn--go' : 'btn btn--sm'}
            onClick={() => setRange(30)}
          >
            30 days
          </button>
        </div>
      </div>

      <div className="grid grid--kpi" style={{ marginBottom: 16 }}>
        <Kpi
          label={`Signups · last ${window.days} days`}
          value={window.signups}
          previous={window.previousSignups}
        />
        <Kpi
          label={`Paid · last ${window.days} days`}
          value={window.paid}
          previous={window.previousPaid}
        />
        <Kpi
          label={`Revenue · last ${window.days} days`}
          value={window.revenuePaise}
          previous={window.previousRevenuePaise}
          money
        />
        <div className="card">
          <p className="kpi__label">Conversion</p>
          <div className="kpi__value">{conversion.toFixed(1)}%</div>
          <p className="kpi__foot">
            of this window’s signups have paid
          </p>
        </div>
      </div>

      <section className="card" style={{ marginBottom: 16 }}>
        <h2>Signups vs paid · last {range} days</h2>
        <SignupPaidChart data={series} />
      </section>

      <div className="grid grid--2">
        <section className="card">
          <h2>Funnel · all time</h2>
          <table className="t">
            <tbody>
              <FunnelRow label="Signed up" value={data.funnel.signups} of={data.funnel.signups} />
              <FunnelRow
                label="Profile completed"
                value={data.funnel.profilesComplete}
                of={data.funnel.signups}
              />
              <FunnelRow
                label="Started a payment"
                value={data.funnel.ordersCreated}
                of={data.funnel.signups}
              />
              <FunnelRow label="Paid" value={data.funnel.paid} of={data.funnel.signups} />
            </tbody>
          </table>
          {data.funnel.abandoned > 0 ? (
            <p className="msg msg--warn" style={{ marginTop: 12, marginBottom: 0 }}>
              <strong>{data.funnel.abandoned}</strong> student
              {data.funnel.abandoned === 1 ? '' : 's'} reached the payment page and did not
              finish. They are the warmest leads you have —{' '}
              <a href="/admin/leads?payment=unpaid">work that list</a>.
            </p>
          ) : null}
        </section>

        <section className="card">
          <h2>Pipeline</h2>
          <table className="t">
            <tbody>
              {data.stages.map((stage) => (
                <tr key={stage.stage}>
                  <td>
                    <a href={`/admin/leads?stage=${stage.stage}`}>
                      {STAGE_LABELS[stage.stage] ?? stage.stage}
                    </a>
                  </td>
                  <td className="tnum nowrap" style={{ textAlign: 'right', width: 90 }}>
                    {stage.count.toLocaleString('en-IN')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>Where they heard about it</h2>
          {data.referrals.length === 0 ? (
            <p className="empty">Nothing yet.</p>
          ) : (
            <table className="t">
              <thead>
                <tr>
                  <th>Source</th>
                  <th style={{ textAlign: 'right' }}>Signups</th>
                  <th style={{ textAlign: 'right' }}>Paid</th>
                  <th style={{ textAlign: 'right' }}>Rate</th>
                </tr>
              </thead>
              <tbody>
                {data.referrals.map((row) => (
                  <tr key={row.source}>
                    <td>{row.source.replace(/_/g, ' ')}</td>
                    <td className="tnum" style={{ textAlign: 'right' }}>{row.signups}</td>
                    <td className="tnum" style={{ textAlign: 'right' }}>{row.paid}</td>
                    <td className="tnum muted-cell" style={{ textAlign: 'right' }}>
                      {row.signups ? `${Math.round((row.paid / row.signups) * 100)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card">
          <h2>Class and target year</h2>
          {data.cohorts.length === 0 ? (
            <p className="empty">Nothing yet.</p>
          ) : (
            <table className="t">
              <thead>
                <tr>
                  <th>Class</th>
                  <th>Target</th>
                  <th style={{ textAlign: 'right' }}>Signups</th>
                  <th style={{ textAlign: 'right' }}>Paid</th>
                </tr>
              </thead>
              <tbody>
                {data.cohorts.map((row) => (
                  <tr key={`${row.class}-${row.target_year}`}>
                    <td>{row.class === 'dropper' ? 'Dropper' : `Class ${row.class}`}</td>
                    <td className="tnum">{row.target_year}</td>
                    <td className="tnum" style={{ textAlign: 'right' }}>{row.signups}</td>
                    <td className="tnum" style={{ textAlign: 'right' }}>{row.paid}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </main>
  );
}

/**
 * A stat tile: the value, and the same window before it.
 *
 * The trend carries an arrow as well as a colour — a red/green pair alone is
 * the most common form of colour blindness, and this is read at a glance.
 */
function Kpi({
  label,
  value,
  previous,
  money = false,
}: {
  label: string;
  value: number;
  previous: number;
  money?: boolean;
}) {
  const shown = money ? `₹${(value / 100).toLocaleString('en-IN')}` : value.toLocaleString('en-IN');
  const change = previous === 0 ? null : Math.round(((value - previous) / previous) * 100);
  const direction = value > previous ? 'up' : value < previous ? 'down' : 'flat';

  return (
    <div className="card">
      <p className="kpi__label">{label}</p>
      <div className="kpi__value">{shown}</div>
      <p className="kpi__foot">
        <span className={`trend trend--${direction}`}>
          {direction === 'up' ? '▲' : direction === 'down' ? '▼' : '—'}
          {change === null ? '' : ` ${Math.abs(change)}%`}
        </span>
        <span>
          vs {money ? `₹${(previous / 100).toLocaleString('en-IN')}` : previous.toLocaleString('en-IN')}{' '}
          previous
        </span>
      </p>
    </div>
  );
}

/** A funnel step with a meter: a ratio against a limit, same-ramp track. */
function FunnelRow({ label, value, of }: { label: string; value: number; of: number }) {
  const share = of > 0 ? (value / of) * 100 : 0;
  return (
    <tr>
      <td style={{ width: '45%' }}>
        {label}
        <div className="progress">
          <div
            className={share >= 99 ? 'progress__fill' : 'progress__fill progress__fill--part'}
            style={{ width: `${Math.max(1, share)}%` }}
          />
        </div>
      </td>
      <td className="tnum nowrap" style={{ textAlign: 'right' }}>
        {value.toLocaleString('en-IN')}
      </td>
      <td className="tnum muted-cell nowrap" style={{ textAlign: 'right', width: 60 }}>
        {share.toFixed(0)}%
      </td>
    </tr>
  );
}
