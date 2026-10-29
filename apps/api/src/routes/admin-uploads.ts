import express, { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { questions, type Pool } from '@jee/db';
import type { Auth } from '../auth.js';
import { currentUser, requireAdmin } from '../middleware/session.js';
import { badRequest } from '../middleware/errors.js';

/** 5 MB, matching the CHECK on question_images. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Image upload for the test designer.
 *
 * The body is the raw file and the type comes from the Content-Type header,
 * rather than a multipart form. That avoids a multipart dependency for a
 * single-file upload, and it is what `fetch(url, { body: file })` sends with no
 * FormData on the client — so the browser side is one line.
 *
 * What makes this safe to serve back from the API's own origin is not the
 * declared type: a header is whatever the client says. It is the magic-number
 * check below, which reads the first bytes of the file and refuses anything
 * that is not actually one of four raster formats.
 */
export function adminUploadRoutes({
  pool,
  auth,
}: {
  pool: Pool;
  auth: Auth;
}): Router {
  const router = Router();
  router.use(requireAdmin(auth, pool));

  /**
   * POST /admin/uploads/image?testId=1
   *
   * Returns `{ url }`, which goes straight into a question's imageUrl. The URL
   * is relative so it keeps working if the API moves host.
   */
  router.post(
    '/image',
    express.raw({
      type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      limit: MAX_IMAGE_BYTES,
    }),
    async (req, res) => {
      const me = currentUser(req);
      const testId = req.query.testId
        ? z.coerce.number().int().positive().parse(req.query.testId)
        : null;

      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        // express.raw leaves a non-Buffer body when the Content-Type did not
        // match its list, which is the common mistake: a file posted with no
        // type, or as multipart.
        throw badRequest(
          'no_image',
          'Send the image file as the request body with its Content-Type set to image/png, image/jpeg, image/webp or image/gif.',
        );
      }

      // The declared type is a claim; this is the check. A file whose bytes say
      // HTML would be served from this origin and run there.
      const sniffed = sniffImageType(body);
      if (!sniffed) {
        throw badRequest(
          'not_an_image',
          'That file is not a PNG, JPEG, WebP or GIF image.',
        );
      }

      const id = randomBytes(16).toString('hex');
      await questions.storeImage(
        { id, testId, uploadedBy: me.id, mimeType: sniffed, body },
        pool,
      );

      res.status(201).json({
        id,
        url: `/papers/images/${id}`,
        mimeType: sniffed,
        sizeBytes: body.length,
      });
    },
  );

  /** The media library for one test, so a figure can be reused. */
  router.get('/images', async (req, res) => {
    const testId = z.coerce.number().int().positive().parse(req.query.testId);
    const images = await questions.listImages(testId, pool);
    res.json({
      images: images.map((image) => ({
        id: image.id,
        url: `/papers/images/${image.id}`,
        mimeType: image.mime_type,
        sizeBytes: image.size_bytes,
        createdAt: image.created_at.toISOString(),
      })),
    });
  });

  return router;
}

/**
 * The declared type, confirmed against the file's own first bytes.
 *
 * Returns the type the signature says, not the one the header claimed, so the
 * stored mime_type always matches the bytes beside it.
 */
function sniffImageType(body: Buffer): string | null {
  if (body.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47
    && body[4] === 0x0d && body[5] === 0x0a && body[6] === 0x1a && body[7] === 0x0a
  ) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF: "GIF87a" or "GIF89a"
  if (body.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/)) {
    return 'image/gif';
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    body.subarray(0, 4).toString('latin1') === 'RIFF'
    && body.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}
