import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import { closePool, getPool } from '@jee/db';

/**
 * Creates synthetic students for the load test, with password hashes produced
 * by Better Auth's own hasher so that the load test signs in through the real
 * auth endpoint rather than a bypass.
 *
 *   pnpm --filter @jee/loadtest seed-students -- --count 2000 --test 1
 *
 * Run this against a staging database. It writes nothing that the event needs
 * and everything it writes is obviously synthetic (@loadtest.invalid).
 */

const args = process.argv.slice(2);
const value = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};

const count = Number(value('count', '500'));
const testId = Number(value('test', '1'));
const password = process.env.STUDENT_PASSWORD ?? 'loadtest-password-1';

if (process.env.NODE_ENV === 'production' && !process.env.ALLOW_SYNTHETIC_STUDENTS) {
  throw new Error(
    'refusing to create synthetic students in production; set ALLOW_SYNTHETIC_STUDENTS to override',
  );
}

const pool = getPool();
// Hashed once: Better Auth's hasher is deliberately slow, and 2,000 of them
// would otherwise take minutes for no benefit — every synthetic student shares
// the same password anyway.
const hash = await hashPassword(password);

const students: { email: string }[] = [];

for (let i = 0; i < count; i += 1) {
  const email = `student-${i}@loadtest.invalid`;
  const userId = `load_${i}`;
  students.push({ email });

  await pool.query(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified")
          VALUES ($1, $2, $3, true)
     ON CONFLICT ("email") DO NOTHING`,
    [userId, `Load Student ${i}`, email],
  );
  await pool.query(
    `INSERT INTO "account" ("id", "accountId", "providerId", "userId", "password")
          VALUES ($1, $2, 'credential', $3, $4)
     ON CONFLICT ("id") DO UPDATE SET "password" = EXCLUDED."password"`,
    [`acc_load_${i}`, userId, userId, hash],
  );
  // Paid, because the lobby refuses anyone who is not and the load test is
  // about the sync path, not the payment path.
  await pool.query(
    `INSERT INTO payments (user_id, test_id, razorpay_order_id, razorpay_payment_id, amount, status)
          VALUES ($1, $2, $3, $4, 50000, 'paid')
     ON CONFLICT (razorpay_payment_id) DO NOTHING`,
    [userId, testId, `order_load_${i}`, `pay_load_${i}`],
  );

  if ((i + 1) % 250 === 0) console.log(`  ${i + 1}/${count}`);
}

const out = join(dirname(fileURLToPath(import.meta.url)), 'students.json');
await writeFile(out, JSON.stringify(students, null, 2));
await closePool();

console.log(`\n${count} synthetic students ready for test ${testId}.`);
console.log(`student list   ${out}`);
console.log(`password       ${password}`);
console.log('\nClean up afterwards:');
console.log(`  delete from attempts where user_id like 'load_%';`);
console.log(`  delete from payments where user_id like 'load_%';`);
console.log(`  delete from "account" where "userId" like 'load_%';`);
console.log(`  delete from "user" where "id" like 'load_%';`);
