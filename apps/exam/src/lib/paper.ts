import { decryptPaper, type EncryptedPaper, type Paper } from '@jee/shared';
import { downloadPaper } from './api.js';
import { loadPaper, savePaper } from './idb.js';

/**
 * Paper delivery.
 *
 * The blob is fetched from the CDN during the lobby, so that by the time the
 * clock hits zero it is already on the student's disk and the start instant
 * costs the origin a ~200 byte key request instead of 1.5 MB of paper.
 */

export async function ensurePaperDownloaded(
  testId: number,
  paperUrl: string,
): Promise<EncryptedPaper> {
  const cached = await loadPaper(testId);
  if (cached) return cached;

  const blob = (await downloadPaper(paperUrl)) as EncryptedPaper;
  if (blob?.v !== 1 || !blob.ct) {
    throw new Error('The downloaded paper is not in the expected format.');
  }
  await savePaper(testId, blob);
  return blob;
}

/**
 * Decrypts with the key released at `starts_at`. GCM is authenticated, so a
 * truncated download fails here rather than rendering half a question — which
 * means "re-download and try again", not "show the student a broken paper".
 */
export async function openPaper(
  testId: number,
  paperUrl: string,
  key: string,
): Promise<Paper> {
  const blob = await ensurePaperDownloaded(testId, paperUrl);
  try {
    return await decryptPaper(blob, key);
  } catch {
    // The cached copy is bad. Fetch it once more before giving up.
    const fresh = (await downloadPaper(paperUrl)) as EncryptedPaper;
    await savePaper(testId, fresh);
    return decryptPaper(fresh, key);
  }
}

export function groupBySubject(paper: Paper): { subject: string; questions: Paper['questions'] }[] {
  const order: string[] = [];
  const bySubject = new Map<string, Paper['questions']>();

  for (const question of paper.questions) {
    if (!bySubject.has(question.subject)) {
      bySubject.set(question.subject, []);
      order.push(question.subject);
    }
    bySubject.get(question.subject)!.push(question);
  }
  return order.map((subject) => ({ subject, questions: bySubject.get(subject)! }));
}
