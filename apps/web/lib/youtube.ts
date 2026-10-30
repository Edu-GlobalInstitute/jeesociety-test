/**
 * Pulling a video id out of a pasted YouTube link.
 *
 * It lives in lib/ rather than beside one component because two places now
 * hold links somebody will paste by hand — the mentor's note on the landing
 * page (components/MentorNote) and the result wall (lib/toppers) — and both
 * should accept whatever shape of link the browser's address bar happened to
 * give them.
 */

/**
 * Pulls the eleven-character video id out of whatever was pasted — a watch
 * URL, a youtu.be short link, an /embed/ or /shorts/ URL, or the bare id.
 * Returns null if there is nothing usable, which is what lets a frame show a
 * "link not added" state instead of a broken player.
 */
export function youtubeId(link: string): string | null {
  const trimmed = link.trim();
  if (!trimmed) return null;
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;

  const match = trimmed.match(/(?:v=|\/embed\/|\/shorts\/|youtu\.be\/|\/v\/)([\w-]{11})/);
  return match ? match[1] : null;
}
