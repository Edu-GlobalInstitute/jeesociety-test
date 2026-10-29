import { Router } from 'express';
import { z } from 'zod';
import { questions, type Pool } from '@jee/db';
import { notFound } from '../middleware/errors.js';

/**
 * Serves the two public artefacts a paper is made of: the encrypted blob and
 * the question figures.
 *
 * Both are unauthenticated, and that is the design rather than an oversight.
 * The blob is ciphertext — without `tests.paper_key`, which GET /attempt/key
 * releases at the start instant and not one millisecond before, it is noise.
 * Serving it without a session is what lets it be cached by the browser, by any
 * proxy in between, and by a CDN if one is put in front, which is the whole
 * reason the paper is a file rather than an API response: 25,000 students
 * fetching the same bytes at 09:00:00 must not each cost a database query.
 *
 * Standing caveat for the scholarship test: these routes put that fetch through
 * the API process. For a mock with a few hundred students that is fine. For the
 * paid event, upload the blob to R2 with tools/build-paper and let
 * `tests.paper_url` point at the CDN — nothing else has to change, because the
 * exam client fetches whatever URL that column holds.
 */
export function paperRoutes({ pool }: { pool: Pool }): Router {
  const router = Router();

  /**
   * The encrypted paper.
   *
   * The digest in the filename is cache-busting, not routing: the test id is
   * what finds the row, and a re-launch changes the digest so a student holding
   * the previous URL cannot be served a stale blob from a cache. The digest in
   * the path is checked against the stored one, so a URL from a previous launch
   * 404s rather than quietly returning the new paper under the old name.
   */
  router.get('/test-:testId-:digest.json', async (req, res) => {
    const testId = z.coerce.number().int().positive().parse(req.params.testId);
    const digest = z.string().regex(/^[0-9a-f]{6,64}$/).parse(req.params.digest);

    const blob = await questions.getPaperBlob(testId, pool);
    if (!blob || !blob.sha256.startsWith(digest)) {
      throw notFound('no_paper', 'No such paper.');
    }

    const etag = `"${blob.sha256}"`;
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    res.setHeader('content-type', 'application/json');
    res.setHeader('etag', etag);
    // Immutable: the digest is in the URL, so these bytes can never change
    // under this path. A year is the longest value browsers honour.
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    // The exam app is served from a different origin to the API.
    res.setHeader('access-control-allow-origin', '*');
    res.send(blob.body);
  });

  /**
   * A question figure.
   *
   * Cached the same way and for the same reason. `nosniff` matters here: these
   * are bytes an admin uploaded, served from the API's own origin, and a
   * browser that decides a file is HTML rather than the declared image type
   * would run it there. The upload route also restricts the type to raster
   * formats, so there are two independent reasons this cannot become a
   * script-bearing document.
   */
  router.get('/images/:imageId', async (req, res) => {
    const imageId = z.string().regex(/^[0-9a-f]{16,64}$/).parse(req.params.imageId);

    const image = await questions.getImage(imageId, pool);
    if (!image) throw notFound('no_image', 'No such image.');

    const etag = `"${image.id}"`;
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    res.setHeader('content-type', image.mime_type);
    res.setHeader('etag', etag);
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-disposition', 'inline');
    res.setHeader('access-control-allow-origin', '*');
    res.send(image.body);
  });

  return router;
}
