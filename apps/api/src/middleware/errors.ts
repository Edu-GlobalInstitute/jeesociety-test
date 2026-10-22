import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import type { Logger } from '../logger.js';

/**
 * A thrown HttpError is the only way a handler reports failure. Express 5
 * forwards rejections from async handlers to the error middleware on its own,
 * which is the reason this codebase is on Express 5 rather than 4.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new HttpError(400, code, message, details);
export const unauthorized = (message = 'Sign in to continue') =>
  new HttpError(401, 'unauthorized', message);
export const forbidden = (code: string, message: string) => new HttpError(403, code, message);
export const notFound = (code: string, message: string) => new HttpError(404, code, message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
export const tooMany = (message: string) => new HttpError(429, 'rate_limited', message);

export function errorHandler(log: Logger): ErrorRequestHandler {
  return (error, req, res, _next) => {
    if (error instanceof HttpError) {
      // Expected refusals are not incidents; log them at the level that keeps
      // the error rate on the dashboard meaningful during the test.
      log.info(
        { path: req.path, status: error.status, code: error.code },
        'request refused',
      );
      res.status(error.status).json({ error: error.code, message: error.message });
      return;
    }

    if (error instanceof ZodError) {
      res.status(400).json({
        error: 'invalid_request',
        message: 'The request body did not match the expected shape.',
        // Paths only — an issue's `received` can echo answer text back into
        // the response and into the log line above it.
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
        })),
      });
      return;
    }

    log.error(
      { err: error instanceof Error ? error.message : String(error), path: req.path },
      'unhandled error',
    );
    res.status(500).json({
      error: 'internal_error',
      message: 'Something went wrong. Your answers are saved.',
    });
  };
}

export const notFoundHandler: RequestHandler = (_req: Request, res: Response) => {
  res.status(404).json({ error: 'not_found', message: 'No such endpoint.' });
};
