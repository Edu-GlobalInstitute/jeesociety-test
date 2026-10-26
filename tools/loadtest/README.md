# Load test

Run this at **twice** expected load before the event, against a deployment sized
the way test day will be sized. Fixing something here costs an afternoon; fixing
it during the event is not possible.

```bash
# 1. Create synthetic students with real Better Auth password hashes.
DATABASE_URL=... pnpm --filter @jee/loadtest seed-students -- --count 2000 --test 1

# 2. Drive the sync endpoint.
API_URL=https://api.example.org k6 run tools/loadtest/sync.js
```

Point the deployment under test at a **Neon branch**, never at the branch the
event will run on — this seeds thousands of synthetic students. The run against
Railway Postgres no longer tells you anything (SYSTEM_DESIGN.md D-006), so the
number that matters is p99 on `/attempt/sync` compared against the Railway
baseline already recorded: that is where the extra network hop would show up.

## What to watch

| Signal | Where | What is wrong if it moves |
| --- | --- | --- |
| p99 latency on `/attempt/sync` | k6 summary | Over ~800 ms means the pool or the database is saturated |
| `db_connection_errors` | API logs | Neon's pooler or compute is at its limit — read the connection graph in the Neon console |
| RSS of the API process | Railway metrics | Growth across the run means a leak; a 3-hour event will find it |
| `http_req_failed` | k6 summary | Anything above ~0.1% at steady load needs explaining before the day |

The stages below are deliberately harsher than the real event: 500 VUs of entry
burst against an expected ~500 req/s peak, and 800 at submit against an expected
spike that the client's 45-second jitter should flatten to ~220/s.
