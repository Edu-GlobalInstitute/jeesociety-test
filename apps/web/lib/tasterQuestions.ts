/**
 * The five questions a visitor can attempt before paying.
 *
 * These are real questions from **JEE Main 2024, 27 January, Shift 1
 * (Physics)** — a paper that is already public — and not questions from the
 * paper being sold. That distinction is stated on the page as well as here:
 * our own paper is unseen, and the answer key for it never leaves the server
 * (SYSTEM_DESIGN.md, hard constraint 2). What this section promises a student
 * is the *level*, which a past paper can show honestly.
 *
 * Two of the five were integer-answer questions in the original paper; the
 * options here were written by us so the taster can be answered in one tap.
 * `integerOriginally` marks those, because the page says so in a footnote.
 *
 * `why` is our own one-line explanation, not the published solution.
 */

export interface TasterQuestion {
  /** Stable key — also the order they are asked in. */
  id: string;
  /** The chapter a student would file this under. */
  topic: string;
  prompt: string;
  /** Always four, as in the real objective section. */
  options: string[];
  answer: number;
  why: string;
  integerOriginally?: boolean;
}

export const TASTER_SOURCE = 'JEE Main 2024 · 27 Jan, Shift 1 · Physics';

export const TASTER_QUESTIONS: TasterQuestion[] = [
  {
    id: 'rod',
    topic: 'Current electricity',
    prompt:
      'A uniform rod has resistance R. It is cut into five equal pieces, and all five pieces '
      + 'are connected in parallel. What is the resistance of the combination?',
    options: ['R/5', 'R/25', '5R', '25R'],
    answer: 1,
    why:
      'Each piece is one-fifth as long, so each is R/5. Five equal resistors in parallel give '
      + 'a fifth of one of them: (R/5)/5 = R/25.',
    integerOriginally: true,
  },
  {
    id: 'gravity',
    topic: 'Gravitation',
    prompt:
      'The acceleration due to gravity at the Earth’s surface is g₀. If the Earth kept the '
      + 'same mass but its radius were halved, what would the surface value become?',
    options: ['g₀ / 2', 'g₀', '2g₀', '4g₀'],
    answer: 3,
    why: 'g = GM/R². The mass is unchanged and R halves, so g goes up by a factor of 2² = 4.',
  },
  {
    id: 'momentum',
    topic: 'Work, energy and momentum',
    prompt:
      'Two particles, of mass 4 g and 25 g, have the same kinetic energy. What is the ratio '
      + 'of their momenta?',
    options: ['2 : 5', '2 : 3', '4 : 5', '3 : 4'],
    answer: 0,
    why:
      'K = p²/2m, so at equal K the momentum goes as √m. The ratio is √4 : √25, which is 2 : 5.',
  },
  {
    id: 'bohr',
    topic: 'Atomic structure',
    prompt:
      'An electron in the third Bohr orbit of a hydrogen-like species has orbit radius R. '
      + 'What is the radius of the fourth orbit of the same species?',
    options: ['25R / 9', '16R / 9', '36R / 9', '9R / 16'],
    answer: 1,
    why: 'Bohr radii go as n²/Z, and Z is the same species, so r₄ = r₃ × (4² / 3²) = 16R/9.',
  },
  {
    id: 'shm',
    topic: 'Oscillations',
    prompt:
      'A particle in SHM has amplitude 4 cm and moves at 10 cm/s as it passes the mean '
      + 'position. How far from the mean position is it moving at 5 cm/s?',
    options: ['2 cm', '2√3 cm', '0.5 cm', '√3 cm'],
    answer: 1,
    why:
      'v = ω√(A² − x²) with ωA = 10. Halving the speed needs √(A² − x²) = A/2, so x = (√3/2)A '
      + '= 2√3 cm.',
    integerOriginally: true,
  },
];
