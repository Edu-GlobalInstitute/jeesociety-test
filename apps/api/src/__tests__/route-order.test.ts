import { describe, expect, it } from 'vitest';
import type { Pool } from '@jee/db';
import { pino } from 'pino';
import type { Router } from 'express';
import { adminCrmRoutes } from '../routes/admin-crm.js';
import { adminTestRoutes } from '../routes/admin-tests.js';
import { adminSecurityRoutes } from '../routes/admin-security.js';
import { adminCouponRoutes } from '../routes/admin-coupons.js';
import { adminRoutes } from '../routes/admin.js';
import type { Auth } from '../auth.js';

/**
 * Route ordering, checked as a property of each router rather than over HTTP.
 *
 * This exists because of a real bug. Express matches routes in registration
 * order, and "/leads/bulk" fits the "/leads/:userId" pattern — so with the
 * parameterised route declared first, every bulk request was swallowed by the
 * single-lead handler with userId = "bulk". "Remove from CRM" answered "No such
 * active CRM lead.", and the bulk stage and owner edits silently wrote nothing
 * at all, which is worse: the UI reported success.
 *
 * Only paths of the same depth collide. "/tests/:testId/questions" does not
 * shadow "/tests/:testId/questions/bulk", because a two-segment pattern cannot
 * match a three-segment path — verified against Express rather than assumed.
 * So the rule below compares segment by segment and only within equal lengths.
 *
 * Needs no database. Each router is built, never called, and its stack is read,
 * so this runs in CI with no Postgres and still guards the thing that broke.
 */

/** The layer shape Express exposes on router.stack. */
interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
  };
}

interface Registered {
  path: string;
  method: string;
  index: number;
}

const stub = {
  pool: {} as Pool,
  auth: {} as Auth,
  log: pino({ level: 'silent' }),
};

/** Every router that registers a parameterised path. */
const ROUTERS: { name: string; build: () => Router }[] = [
  { name: 'admin-crm', build: () => adminCrmRoutes(stub) },
  { name: 'admin-tests', build: () => adminTestRoutes(stub) },
  { name: 'admin-security', build: () => adminSecurityRoutes(stub) },
  { name: 'admin-coupons', build: () => adminCouponRoutes(stub) },
  { name: 'admin', build: () => adminRoutes(stub) },
];

function routesOf(router: Router): Registered[] {
  const stack = (router as unknown as { stack: RouteLayer[] }).stack;
  const routes: Registered[] = [];
  stack.forEach((layer, index) => {
    if (!layer.route) return;
    for (const method of Object.keys(layer.route.methods)) {
      routes.push({ path: layer.route.path, method, index });
    }
  });
  return routes;
}

const segments = (path: string) => path.split('/').filter(Boolean);

/**
 * Whether `pattern` would match a request for `literal` — same depth, and every
 * segment either identical or a `:param` in the pattern.
 */
function wouldShadow(pattern: string, literal: string): boolean {
  const a = segments(pattern);
  const b = segments(literal);
  if (a.length !== b.length) return false;
  if (!a.some((part) => part.startsWith(':'))) return false;
  return a.every((part, i) => part.startsWith(':') || part === b[i]);
}

describe('route registration order', () => {
  /**
   * The general rule, applied to every router: a literal path must never be
   * registered after a parameterised path that would swallow it.
   */
  it.each(ROUTERS)('$name registers literal paths before the patterns that match them', ({ build }) => {
    const routes = routesOf(build());
    const problems: string[] = [];

    for (const literal of routes) {
      if (segments(literal.path).some((part) => part.startsWith(':'))) continue;

      for (const pattern of routes) {
        if (pattern.method !== literal.method) continue;
        if (!wouldShadow(pattern.path, literal.path)) continue;
        if (pattern.index < literal.index) {
          problems.push(
            `${literal.method.toUpperCase()} ${literal.path} is unreachable: `
              + `${pattern.path} is registered before it and matches the same request`,
          );
        }
      }
    }

    expect(problems).toEqual([]);
  });

  /**
   * The specific regression, kept as its own case so a failure names it
   * directly. Both verbs: DELETE surfaced as a visible error, POST failed
   * silently.
   */
  it.each([
    ['post', '/leads/bulk', '/leads/:userId'],
    ['delete', '/leads/bulk', '/leads/:userId'],
  ])('%s %s comes before %s', (method, literal, parameterised) => {
    const routes = routesOf(adminCrmRoutes(stub));
    const bulk = routes.find((r) => r.path === literal && r.method === method);
    const single = routes.find((r) => r.path === parameterised && r.method === method);

    expect(bulk, `${method.toUpperCase()} ${literal} is not registered`).toBeDefined();
    expect(single, `${method.toUpperCase()} ${parameterised} is not registered`).toBeDefined();
    expect(bulk!.index).toBeLessThan(single!.index);
  });
});
