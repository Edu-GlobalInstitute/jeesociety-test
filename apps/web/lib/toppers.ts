/**
 * The result wall: the students whose podcasts sit on /results.
 *
 * Every name, number and claim below was taken from the video's own
 * description on the JEEsociety channel, so the page cannot credit a student
 * with a score their own video does not state. Where a video never published
 * a percentile — Krish's does not — `percentile` is null and `seat` carries
 * what the video does say, the seat he took, rather than a number invented to
 * fill the shape of the card.
 *
 * To add a fifth student, paste the link and fill the same fields; the wall
 * lays itself out from the length of this list.
 */

export interface Topper {
  /** Any YouTube link shape, or the bare id — lib/youtube resolves it. */
  link: string;
  /** First name only, which is all the videos give. */
  name: string;
  /** The headline number, counted up as the card arrives. */
  percentile: number | null;
  /** Stands in for the number when the video published a seat instead. */
  seat: string | null;
  /** The small line under the headline: which exam, which attempt. */
  badge: string;
  /** The video's own title, as published. */
  title: string;
  /** One line on what the conversation is actually about. */
  hook: string;
}

export const TOPPERS: Topper[] = [
  {
    link: 'https://youtu.be/6f9oh30WDLY',
    name: 'Prahalad',
    percentile: 99.66,
    seat: null,
    badge: 'JEE Main 2026',
    title: 'JEE Main Topper Reveals His Biggest Struggles & Comeback Strategy',
    hook:
      'Lectures he could not follow, maths he could not solve, test marks going the '
      + 'wrong way all through revision — and 99.66 at the end of it.',
  },
  {
    link: 'https://youtu.be/I3yAmY7qm4Y',
    name: 'Shubh',
    percentile: 99.5,
    seat: null,
    badge: 'JEE Main',
    title: 'These 10 minutes will help you crack IIT Bombay (Honest Talk)',
    hook:
      'Every book and every teacher he actually used, plus the Class 11 low point '
      + 'and the jealousy nobody posts about.',
  },
  {
    link: 'https://youtu.be/2VaKRBHdHao',
    name: 'Sanskar',
    percentile: 99.5,
    seat: null,
    badge: 'JEE Main · drop year',
    title: 'The Brutal Reality of JEE: What It Really Takes to Score 99.5%ile',
    hook:
      'No secret timetable and no study-16-hours-a-day advice. The burnout, the '
      + 'teacher-hopping, and the mistakes that cost him months.',
  },
  {
    link: 'https://youtu.be/5mz-oQ49M1g',
    name: 'Krish',
    percentile: null,
    seat: 'IIT Roorkee',
    badge: 'Drop year · cleared Mains and Advanced',
    title: "Full Syllabus Backlog to IIT Roorkee | JEE Dropper's Magical Journey",
    hook:
      'A whole syllabus of backlog and a drop year that looked lost, turned around '
      + 'on discipline rather than on a new timetable.',
  },
];
