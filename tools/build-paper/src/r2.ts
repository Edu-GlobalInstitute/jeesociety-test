import { createHash, createHmac } from 'node:crypto';

/**
 * A minimal SigV4 PUT against R2's S3-compatible endpoint. Hand-rolled rather
 * than pulling in the AWS SDK: this tool makes exactly one kind of request, and
 * the rest of the stack has no AWS dependency to amortise it against.
 */

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export async function putObject(
  config: R2Config,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const path = `/${config.bucket}/${key}`;
  const payloadHash = createHash('sha256').update(body).digest('hex');

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';

  const canonical = [
    'PUT',
    path,
    '',
    `content-type:${contentType}`,
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    '',
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonical).digest('hex'),
  ].join('\n');

  const hmac = (key: Buffer | string, data: string) =>
    createHmac('sha256', key).update(data).digest();
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), 'auto'), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const response = await fetch(`https://${host}${path}`, {
    method: 'PUT',
    headers: {
      'content-type': contentType,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      // The paper is public by design — it is encrypted, and the key is what
      // is withheld until starts_at. A long max-age is what keeps 10,000
      // downloads at the edge instead of at the origin.
      'cache-control': 'public, max-age=31536000, immutable',
      authorization:
        `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: new Uint8Array(body),
  });

  if (!response.ok) {
    throw new Error(`R2 upload failed: ${response.status} ${await response.text()}`);
  }
  return key;
}
