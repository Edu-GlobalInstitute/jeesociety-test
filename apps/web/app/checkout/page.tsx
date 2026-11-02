import Link from 'next/link';
import { TEST_FEE_PAISE } from '@jee/shared/config';
import { TEST_WHEN } from '../../lib/testDate';
import '../auth.css';
import './checkout.css';

/** Information page only; account and server-authoritative payment live in registration. */
export default function Checkout() {
  const price = (TEST_FEE_PAISE / 100).toLocaleString('en-IN');
  return <main className="checkout"><div className="checkout__card">
    <h1 className="auth__title">Register for the scholarship test</h1>
    <p className="auth__sub">The registration fee is ₹{price}. The test is scheduled for {TEST_WHEN}.</p>
    <section className="auth__panel">
      <h2>Ready to register?</h2>
      <p>Create an account or sign in, complete your student profile, then pay securely. If you have a coupon, enter it on the payment page; the final discount is checked by the server.</p>
      <Link className="btn btn--mark auth__submit" href="/signup">Create student account</Link>
      <p className="auth__sub">Already registered? <Link href="/login">Sign in</Link></p>
    </section>
  </div></main>;
}
