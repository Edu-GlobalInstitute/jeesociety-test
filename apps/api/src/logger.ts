import { pino, type Logger as PinoLogger } from 'pino';

/**
 * Structured JSON logs.
 *
 * Nothing in this system logs answer content. Most students are under 18 and
 * their answers are the most sensitive thing here; the redact list below is a
 * backstop, but the real rule is that handlers log counts and ids, never text.
 */
export function createLogger(level: string, name = 'api'): PinoLogger {
  return pino({
    name,
    level,
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["x-razorpay-signature"]',
        'res.headers["set-cookie"]',
        '*.answers',
        '*.answer',
        '*.paper_key',
        '*.paperKey',
        '*.answer_key',
        '*.answerKey',
        '*.key',
        '*.password',
      ],
      censor: '[redacted]',
    },
    base: { service: name },
  });
}

export type Logger = PinoLogger;
