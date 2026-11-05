'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, adminErrorMessage } from '../../../lib/api';

interface Coupon {
  id: number; name: string; code: string; discountRupees: number; active: boolean;
  redeemedCount: number; pendingCount: number;
}

/**
 * A new coupon starts at the standard discount.
 *
 * Every marketing code takes the same amount off, so a student comparing two
 * codes is never told one is worth more than another and support never has to
 * explain the difference. The field is still editable for a one-off; it just
 * does not start empty and invite a different number each time.
 */
const blank = { name: '', code: '', discountRupees: '' };

export default function CouponsPage() {
  const [list, setList] = useState<Coupon[]>([]);
  const [standard, setStandard] = useState<number | null>(null);
  const [maxDiscount, setMaxDiscount] = useState<number | null>(null);
  const [form, setForm] = useState(blank);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      api<{ coupons: Coupon[]; standardDiscountRupees: number; maxDiscountRupees: number }>(
        '/admin/coupons',
      )
        .then((data) => {
          setList(data.coupons);
          setStandard(data.standardDiscountRupees);
          setMaxDiscount(data.maxDiscountRupees);
          // Prefill an untouched form, never one being typed into.
          setForm((current) =>
            current.discountRupees === ''
              ? { ...current, discountRupees: String(data.standardDiscountRupees) }
              : current,
          );
        })
        .catch((caught) => setError(adminErrorMessage(caught, 'coupons'))),
    [],
  );
  useEffect(() => { void load(); }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api('/admin/coupons', { method: 'POST', body: JSON.stringify({
        name: form.name, code: form.code.trim().toUpperCase(), discountRupees: Number(form.discountRupees),
      }) });
      setForm({ ...blank, discountRupees: standard === null ? '' : String(standard) });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create the coupon.');
    } finally { setBusy(false); }
  }

  async function toggle(row: Coupon) {
    setError('');
    try {
      await api(`/admin/coupons/${row.id}`, { method: 'POST', body: JSON.stringify({
        name: row.name, code: row.code, discountRupees: row.discountRupees, active: !row.active,
      }) });
      await load();
    } catch (caught) { setError(caught instanceof ApiError ? caught.message : 'Could not update the coupon.'); }
  }

  return <main className="ap">
    <div className="ap__head"><div><h1>Coupons</h1><p className="ap__sub">Discounts are validated and applied by the payment server.</p></div></div>
    {error ? <p className="msg msg--bad" role="alert">{error}</p> : null}
    <section className="card" style={{ marginBottom: 16 }}>
      <h2>Create a coupon</h2>
      <form onSubmit={create} className="row" style={{ alignItems: 'end', flexWrap: 'wrap' }}>
        <label className="field"><span>Name</span><input className="inp" required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="field"><span>Code</span><input className="inp" required minLength={3} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,31}" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} /></label>
        <label className="field">
          <span>Discount (₹)</span>
          <input
            className="inp"
            type="number"
            required
            min="0.01"
            max={maxDiscount ?? undefined}
            step="0.01"
            value={form.discountRupees}
            onChange={(e) => setForm({ ...form, discountRupees: e.target.value })}
          />
          {standard !== null ? (
            <span className="field__hint">
              Every marketing code takes ₹{standard} off, so students comparing two codes are
              never told one is worth more. Change it only for a one-off.
            </span>
          ) : null}
        </label>
        <button className="btn btn--go" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create coupon'}</button>
      </form>
      <p className="ap__sub">Each student can redeem a code once. Its use count increases only after payment is confirmed; a full discount confirms registration immediately.</p>
    </section>
    <section className="card">
      <div className="table-wrap"><table><thead><tr><th>Name</th><th>Code</th><th>Discount</th><th>Paid uses</th><th>Pending</th><th>Status</th><th /></tr></thead>
        <tbody>{list.map((row) => <tr key={row.id}><td>{row.name}</td><td><code>{row.code}</code></td><td>₹{row.discountRupees.toLocaleString('en-IN')}</td><td>{row.redeemedCount}</td><td>{row.pendingCount}</td><td>{row.active ? 'Active' : 'Inactive'}</td><td><button className="btn btn--sm" type="button" onClick={() => void toggle(row)}>{row.active ? 'Deactivate' : 'Activate'}</button></td></tr>)}
          {!list.length ? <tr><td colSpan={7}>No coupons created yet.</td></tr> : null}</tbody></table></div>
    </section>
  </main>;
}
