import type { Logger } from 'pino';

/**
 * Sending mail, through Resend's HTTP API.
 *
 * No SDK. The whole surface we use is one POST with a JSON body, and a
 * dependency that wraps that is a dependency to audit, update and explain
 * before 29 November. `fetch` is in Node 20.
 *
 * One rule runs through this file: a mail failure must never fail the request
 * that triggered it. Every function here resolves, logs, and returns whether
 * it worked. The caller decides what to tell the user, and for a password
 * reset the answer is always the same thing regardless (see routes/auth-extra).
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** How long we wait on Resend before giving up on a single send. */
const SEND_TIMEOUT_MS = 10_000;

export interface MailerConfig {
  apiKey: string;
  from: string;
  log: Logger;
}

export interface SendResult {
  sent: boolean;
  /** Set when sent is false. Already safe to log: never contains the body. */
  reason?: string;
}

export interface Mailer {
  /** True when an API key is configured. False means every send is a no-op. */
  readonly enabled: boolean;
  send(message: { to: string; subject: string; html: string; text: string }): Promise<SendResult>;
}

export function createMailer(config: MailerConfig): Mailer {
  const enabled = Boolean(config.apiKey);

  if (!enabled) {
    config.log.warn(
      'RESEND_API_KEY is not set — password reset emails will not be sent. ' +
        'The site works; students who forget a password must contact you.',
    );
  }

  return {
    enabled,

    async send(message) {
      if (!enabled) return { sent: false, reason: 'mail_not_configured' };

      /*
       * A timeout, because this runs inside an HTTP request. Resend is
       * normally fast, but a hung connection here would hold a student's
       * browser on a spinner until the proxy gave up on them.
       */
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), SEND_TIMEOUT_MS);

      try {
        const response = await fetch(RESEND_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: config.from,
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
          }),
          signal: abort.signal,
        });

        if (!response.ok) {
          /*
           * Resend's error body names the problem — an unverified sending
           * domain, a malformed address, a revoked key — and all of it is
           * about our configuration rather than the student, so it is safe
           * to log in full and genuinely useful at 2am.
           */
          const detail = await response.text().catch(() => '');
          config.log.error(
            { status: response.status, detail: detail.slice(0, 500) },
            'resend rejected the message',
          );
          return { sent: false, reason: `resend_${response.status}` };
        }

        return { sent: true };
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        config.log.error(
          { err: error instanceof Error ? error.message : String(error) },
          aborted ? 'resend timed out' : 'resend request failed',
        );
        return { sent: false, reason: aborted ? 'timeout' : 'network_error' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The reset email itself.
 *
 * Plain, short, and says what to do if it was not you. Both an HTML and a
 * text part: a text part is not politeness, it is what stops a single-part
 * HTML mail scoring as spam, and this message must reach an inbox on the
 * first try or the student is stuck.
 *
 * The link is written out as text under the button as well. Some Indian
 * mobile mail clients strip anchor styling, and a student who cannot see a
 * button needs something to copy.
 */
export function resetPasswordEmail(params: { url: string; expiresMinutes: number }): {
  subject: string;
  html: string;
  text: string;
} {
  const { url, expiresMinutes } = params;

  const subject = 'Reset your JEE Society password';

  const text = [
    'Someone asked to reset the password for this JEE Society account.',
    '',
    'Open this link to choose a new one:',
    url,
    '',
    `The link works for ${expiresMinutes} minutes and can be used once.`,
    '',
    'If this was not you, ignore this email. Your password has not changed',
    'and nobody can get in without this link.',
    '',
    'JEE Society',
  ].join('\n');

  /*
   * Table-based layout with inline styles. Not a style choice: Gmail strips
   * <style> blocks and many clients ignore flexbox, and a reset email that
   * renders as unstyled text in Gmail is the one that does not get clicked.
   */
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#fbf5ea;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbf5ea;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e7dcc7;border-radius:8px;padding:32px;">
<tr><td style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#1b2440;">
<h1 style="margin:0 0 18px;font-size:21px;line-height:1.3;color:#1b2440;">Reset your password</h1>
<p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#4a5670;">
Someone asked to reset the password for this JEE&nbsp;Society account.
Choose a new one here:
</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
<tr><td style="background:#ffc93c;border-radius:6px;">
<a href="${escapeHtml(url)}" style="display:inline-block;padding:13px 26px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;font-weight:700;color:#1b2440;text-decoration:none;">Set a new password</a>
</td></tr></table>
<p style="margin:0 0 18px;font-size:13px;line-height:1.6;color:#7c8699;word-break:break-all;">
Or copy this link:<br><span style="color:#4a5670;">${escapeHtml(url)}</span>
</p>
<p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#4a5670;">
The link works for ${expiresMinutes} minutes and can be used once.
</p>
<p style="margin:0;padding-top:18px;border-top:1px solid #e7dcc7;font-size:13px;line-height:1.6;color:#7c8699;">
If this was not you, ignore this email. Your password has not changed, and
nobody can get in without this link.
</p>
</td></tr></table>
</td></tr></table>
</body></html>`;

  return { subject, html, text };
}

/**
 * The reset URL is built from a token we generated and an origin from our own
 * configuration, so neither is attacker-controlled — but it is interpolated
 * into HTML, and a future caller may be less careful about what it passes.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
