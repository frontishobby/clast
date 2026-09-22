/**
 * Room codes people read off a screen and type into a phone.
 *
 * The alphabet drops 0/O/1/I/L and any lookalike pair, because the whole
 * point is that someone reads this aloud or copies it from a screenshot.
 * 31 symbols over 5 places is ~28.6M codes, far more than enough for
 * simultaneous rooms while staying short enough to say out loud.
 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 5;

/** Characters people commonly substitute, folded on input. */
const CONFUSIONS: Record<string, string> = {
  '0': 'Q',
  O: 'Q',
  '1': '7',
  I: 'J',
  L: 'J',
};

export function randomCode(random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Cleans up what someone typed: case, spacing, and the handful of glyphs the
 * alphabet deliberately avoids. Returns null when it still is not a valid code.
 */
export function normalizeCode(input: string): string | null {
  const cleaned = [...input.trim().toUpperCase().replace(/[\s-]/g, '')]
    .map((c) => CONFUSIONS[c] ?? c)
    .join('');
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const c of cleaned) if (!CODE_ALPHABET.includes(c)) return null;
  return cleaned;
}

/** Only the characters a code can contain, for filtering keystrokes. */
export function isCodeChar(c: string): boolean {
  const up = c.toUpperCase();
  return CODE_ALPHABET.includes(CONFUSIONS[up] ?? up);
}
