import { closePool, getPool } from '../pool.js';
import { migrate } from '../migrate.js';

const result = await migrate(getPool(), undefined, (message) => console.log(message));
if (result.applied.length === 0) {
  console.log(`up to date (${result.alreadyApplied.length} migrations)`);
} else {
  console.log(`applied ${result.applied.length}: ${result.applied.join(', ')}`);
}
await closePool();
