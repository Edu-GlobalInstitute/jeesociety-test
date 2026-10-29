/**
 * Prints the SQL to set the admin password, using Better Auth's own hasher.
 *
 * There is no email sending in this deployment, so the built-in reset flow has
 * no way to deliver a link. This produces the same `salt:hash` scrypt string
 * Better Auth writes itself -- it imports the library's hashPassword rather
 * than reimplementing it, so the format cannot drift from what verifyPassword
 * expects.
 *
 *   node make-admin-password.mjs 'your-new-password'
 */
import { hashPassword } from 'better-auth/crypto';

const password = process.argv[2];
const email = process.argv[3] ?? 'jeesocietydev@gmail.com';

if (!password || password.length < 8) {
  console.error('usage: node make-admin-password.mjs <password-8-chars-min> [email]');
  process.exit(1);
}

const hash = await hashPassword(password);

// Sanity check: the hash must verify against the password it came from.
const { verifyPassword } = await import('better-auth/crypto');
if (!(await verifyPassword({ hash, password }))) {
  console.error('refusing to print: the hash did not verify against its own password');
  process.exit(1);
}

console.log(`
-- Sets the password for ${email}. Verified round-trip before printing.
-- scrypt N=16384 r=16 p=1 dkLen=64, 16-byte random salt: the exact format
-- Better Auth's verifyPassword reads.

UPDATE "account" SET "password" = '${hash}', "updatedAt" = now()
 WHERE "providerId" = 'credential'
   AND "userId" = (SELECT "id" FROM "user" WHERE lower("email") = lower('${email}'));

-- If that reports 0 rows, the account has no credential row at all (a
-- Google-only account). Create one instead:

INSERT INTO "account" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, u."id", 'credential', u."id",
       '${hash}', now(), now()
  FROM "user" u
 WHERE lower(u."email") = lower('${email}')
   AND NOT EXISTS (
     SELECT 1 FROM "account" a
      WHERE a."userId" = u."id" AND a."providerId" = 'credential'
   );

-- Then make sure it is an admin:
INSERT INTO admins (user_id, note)
SELECT "id", 'owner' FROM "user" WHERE lower("email") = lower('${email}')
ON CONFLICT (user_id) DO NOTHING;
`);
