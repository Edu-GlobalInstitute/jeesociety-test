import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { clientKey } from '../middleware/rateLimit.js';

/**
 * Which address the limiter counts against.
 *
 * This is the test for an outage, not a feature. Express derives `req.ip` by
 * walking X-Forwarded-For back by the configured number of trusted hops, so a
 * wrong hop count makes it a *proxy's* address — and then every user shares one
 * bucket. Adding the same-origin proxy made the chain browser → Cloudflare →
 * Render → API while TRUST_PROXY_HOPS still said one, and sign-in started
 * answering "Too Many Requests" to people who had tried once.
 *
 * Preferring cf-connecting-ip removes the arithmetic: Cloudflare sets it to the
 * real client and overwrites anything the client sent, and this API is only
 * reachable through it.
 */

function fakeRequest(headers: Record<string, string>, ip?: string): Request {
  return { headers, ip } as unknown as Request;
}

describe('clientKey', () => {
  it('uses the real client address when Cloudflare provides one', () => {
    const req = fakeRequest({ 'cf-connecting-ip': '49.37.1.2' }, '172.71.0.9');
    expect(clientKey(req)).toBe('49.37.1.2');
  });

  /**
   * The bug, stated directly: two students behind the same proxy must not share
   * a bucket. Before this they both keyed on the proxy's address.
   */
  it('separates two clients that arrive through the same proxy', () => {
    const proxyIp = '172.71.0.9';
    const first = fakeRequest({ 'cf-connecting-ip': '49.37.1.2' }, proxyIp);
    const second = fakeRequest({ 'cf-connecting-ip': '49.37.1.3' }, proxyIp);

    expect(clientKey(first)).not.toBe(clientKey(second));
  });

  it('falls back to req.ip when the header is absent', () => {
    expect(clientKey(fakeRequest({}, '49.37.1.2'))).toBe('49.37.1.2');
  });

  it('falls back when the header is empty rather than keying on an empty string', () => {
    expect(clientKey(fakeRequest({ 'cf-connecting-ip': '' }, '49.37.1.2'))).toBe('49.37.1.2');
  });

  /**
   * Never an empty or undefined key: everything with no address would otherwise
   * collapse into one bucket, which is the failure this file exists to prevent.
   */
  it('always returns something to count against', () => {
    expect(clientKey(fakeRequest({}))).toBe('unknown');
  });
});
