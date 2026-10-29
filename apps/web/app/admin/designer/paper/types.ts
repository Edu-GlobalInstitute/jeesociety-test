/** Shared shapes for the paper editor. */

export interface QuestionOption {
  key: string;
  body: string;
  imageUrl?: string | null;
}

export interface Question {
  /** 0 for a question that has not been saved yet. */
  id: number;
  questionRef: string;
  subject: string;
  kind: 'scq' | 'integer';
  position: number;
  body: string;
  options: QuestionOption[];
  correctAnswer: string | null;
  imageUrl: string | null;
  solutionText: string | null;
  solutionImageUrl: string | null;
  unit: string | null;
  marksCorrect: number;
  marksWrong: number;
  updatedAt: string | null;
}

export interface Shape {
  subjects: readonly string[];
  scqPerSubject: number;
  integerPerSubject: number;
  totalCount: number;
  maxMarks: number;
}

export interface TestSummary {
  id: number;
  name: string;
  kind: string;
  requiresPayment: boolean;
  durationMinutes: number;
  startsAt: string;
  endsAt: string;
  lobbyOpensAt: string;
  paperPublished: boolean;
  status: string;
}

/**
 * Uploads one image and returns the URL to store on a question.
 *
 * The file is the request body with its own Content-Type, not a FormData part —
 * see routes/admin-uploads.ts. The URL comes back relative, so it keeps working
 * if the API changes host; the editor prefixes it for display only.
 */
export async function uploadImage(file: File, testId: number): Promise<string> {
  const base = process.env.NEXT_PUBLIC_API_URL ?? '';
  const response = await fetch(`${base}/admin/uploads/image?testId=${testId}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': file.type },
    body: file,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(body.message ?? 'Could not upload that image.');
  }
  return body.url as string;
}

/** Images are stored as relative URLs; this is for displaying them. */
export function imageSrc(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('http')) return url;
  return `${process.env.NEXT_PUBLIC_API_URL ?? ''}${url}`;
}
