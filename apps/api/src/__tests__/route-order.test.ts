import { describe, expect, it } from 'vitest';
import type { Pool } from '@jee/db';
import { pino } from 'pino';
import { adminCrmRoutes } from '../routes/admin-crm.js';
import type { Auth } from '../auth.js';

/**
 * Route ordering, checked as a property of the router rather than over HTTP.
 *
 * This exists because of a real bug. Express matches routes in registration
 * order, and "/leads/bulk" fits the "/leads/:userId" pattern — so with the
 * parameterised route declared first, every bulk request was swallowed by the
 * single-lead handler with userId = "bulk". "Remove from CRM" answered "No such
 * active CRM lead.", and the bulk stage and owner edits silently wrote nothing
 * at all, which is worse: the UI reported success.
 *
 * Needs no database. The router is built, never called, and its stack is read —
 * so this runs in CI with no Postgres and still guards the thing that broke.
 */

/** The layer shape Express exposes on router.stack. */
interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
  };
}

function leadRoutes(): { path: string; method: string; index: number }[] {
  // Never used: the router is inspected, not invoked.
  const router = adminCrmRoutes({
    pool: {} as Pool,
    auth: {} as Auth,
    log: pino({ level: 'silent' }),
  });

  const stack = (router as unknown as { stack: RouteLayer[] }).stack;
  const routes: { path: string; method: string; index: number }[] = [];

  stack.forEach((layer, index) => {
    if (!layer.route) return;
    for (const method of Object.keys(layer.route.methods)) {
      routes.push({ path: layer.route.path, method, index });
    }
  });
  return routes;
}

describe('admin CRM route order', () => {
  /**
   * The specific regression. Both verbs are checked because both were broken:
   * DELETE surfaced as a visible error, POST failed silently.
   */
  it.each([
    ['post', '/leads/bulk', '/leads/:userId'],
    ['delete', '/leads/bulk', '/leads/:userId'],
  ])(
    '%s %s is registered before %s',
    (method, literal, parameterised) => {
      const routes = leadRoutes();
      const bulk = routes.find((r) => r.path === literal && r.method === method);
      const single = routes.find((r) => r.path === parameterised && r.method === method);

      expect(bulk, `${method.toUpperCase()} ${literal} is not registered`).toBeDefined();
      expect(single, `${method.toUpperCase()} ${parameterised} is not registered`).toBeDefined();
      expect(
        bulk!.index,
        `${method.toUpperCase()} ${literal} must come before ${parameterised}, `
          + 'or Express matches the parameterised route first and treats "bulk" as a user id',
      ).toBeLessThan(single!.index);
    },
  );

  /**
   * The general rule, so a literal segment added later is covered without
   * anyone remembering to extend the case above. /leads/owners and
   * /leads/export were already correct; this keeps them that way.
   */
  it('registers every literal /leads/<word> path before /leads/:userId', () => {
    const routes = leadRoutes();

    for (const route of routes) {
      const match = /^\/leads\/([a-z-]+)$/.exec(route.path);
      if (!match) continue;

      const single = routes.find(
        (r) => r.path === '/leads/:userId' && r.method === route.method,
      );
      if (!single) continue;

      expect(
        route.index,
        `${route.method.toUpperCase()} ${route.path} is shadowed by /leads/:userId`,
      ).toBeLessThan(single.index);
    }
  });
});
