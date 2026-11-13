// Guardrails for text that may reach other people: prayers, intentions, display names.
// Reasons are for logs and metrics only and are never returned to a model.

import { gzipSync } from 'node:zlib';
import { C } from '../../../shared/constants.js';
import { cleanText, foldLatin, words, denylistTokens, foldForDenylist } from './normalize.js';
import { LATIN_WORDS } from './data/latin-words.js';
import { DENY_TOKENS, DENY_SUBSTRINGS } from './data/denylist.js';

export { cleanText } from './normalize.js';

export type RejectReason =
  | 'empty'
  | 'too_long'
  | 'leak_shaped'
  | 'not_latin'
  | 'denylist'
  | 'padding';

export type Verdict = { ok: true; text: string } | { ok: false; reason: RejectReason };

const LATIN = new Set(LATIN_WORDS.split('\n'));
/**
 * Entries of the multilingual denylist that are let through after all. The list (LDNOOBW) is
 * built to be cautious for any site in any language, so it sweeps up a good deal that is not
 * abuse: people's names, everyday words that are slang somewhere, plain words for the body
 * and for things people do pray about, and mild oaths. What stays blocked is what the list
 * is really for: slurs against groups of people, hard obscenity and pornographic terms.
 *
 * Entries are in the list's folded form (lower case, no diacritics).
 */
export const DENY_ALLOWED: ReadonlySet<string> = new Set(
  [
    // Names of people (and a console maker).
    'peter anita dick del mona pele pitt sega',
    // Everyday words in English, Spanish, French, Italian, Portuguese or Latin.
    'bite con fan got gotten hard franc comer burro pinto stake trio mama pot escort domination bondage suck butt gat gol',
    'perse pica pico sas tanga rosette pompa saco pataka scat snatch swinger fingering mufti bander bur bobo bonze biga',
    'panna pau pina reet sike gerbe concha fava hol',
    // Plain words for the body, for sexuality and for wrongs done: things a prayer may be about.
    'anal clitoris ejaculation fecal genitals heterosexual homosexual intercourse nipple nude nudity penis pubes sexual',
    'sexuality sexually eunuch incest rape raping rapist sodomy sadism masturbate masturbation pornography porn orgy orgasm',
    'nazi swastika bestiality voyeur topless erotic erotism autoerotic homoerotic',
    // Mild oaths and rude words.
    'ass bastard bitch whore hooker boob tit titty cock sexy horny smut playboy spunk tosser kinky',
  ]
    .join(' ')
    .split(' ')
    .concat([
      // Phrases that are ordinary speech.
      'big black',
      'god damn',
      'hard core',
      'tied up',
      'tight white',
      'girl on',
      'girl on top',
      'taste my',
      'tongue in a',
      'how to kill',
      'how to murder',
      'huge fat',
      'hot chick',
      'tainted love',
      's m',
      'wrapping men',
      'sultry women',
      'jelly donut',
      'date rape',
      'de hond uitlaten',
      'gras maaien',
      'porca miseria',
    ]),
);
const DENY_SINGLE = new Set<string>();
const DENY_PHRASES: string[][] = [];
for (const entry of DENY_TOKENS.split('\n')) {
  if (!entry || DENY_ALLOWED.has(entry)) continue;
  const toks = entry.split(' ');
  if (toks.length === 1) DENY_SINGLE.add(toks[0]!);
  else DENY_PHRASES.push(toks);
}
const DENY_SUBSTR = DENY_SUBSTRINGS.split('\n').filter(Boolean);

/** Patterns that look like leaked context rather than liturgy. */
const LEAK_PATTERNS: [string, RegExp][] = [
  ['url', /\b(?:https?|ftp|file|ssh|git|mailto):/i],
  ['www', /\bwww\./i],
  ['path_separator', /[/\\]/],
  ['at_sign', /@/],
  ['brackets', /[{}[\]()<>]/],
  ['equals_or_semicolon', /[=;]/],
  // Code-ish punctuation that never appears in a Latin prayer.
  ['code_punctuation', /[`|$#*^~]/],
  // A dot directly between word characters: file.ts, example.com, v1.2.
  ['file_extension', /[\p{L}\p{N}_]\.[\p{L}\p{N}]/u],
  ['camel_case', /\p{Ll}\p{Lu}/u],
  ['snake_case', /_/],
  ['long_number', /\d{5,}/],
];

export function leakShaped(text: string): string | null {
  for (const [name, re] of LEAK_PATTERNS) if (re.test(text)) return name;
  return null;
}

/** Share of words found in the bundled Latin wordlist (0 for text with no words). */
export function latinRatio(text: string): number {
  const ws = words(text);
  if (ws.length === 0) return 0;
  let known = 0;
  for (const w of ws) if (LATIN.has(foldLatin(w))) known++;
  return known / ws.length;
}

export function denied(text: string): boolean {
  const toks = denylistTokens(text);
  for (const t of toks) if (DENY_SINGLE.has(t)) return true;
  if (DENY_PHRASES.length > 0) {
    for (let i = 0; i < toks.length; i++) {
      for (const phrase of DENY_PHRASES) {
        if (phrase.every((p, j) => toks[i + j] === p)) return true;
      }
    }
  }
  const squashed = foldForDenylist(text).replace(/\s+/g, '');
  return DENY_SUBSTR.some((s) => squashed.includes(s));
}

/** gzip size over raw size. Very repetitive text compresses far below normal prose. */
export function compressionRatio(text: string): number {
  const raw = Buffer.byteLength(text, 'utf8');
  if (raw === 0) return 1;
  return gzipSync(Buffer.from(text, 'utf8')).length / raw;
}

export const LATIN_MIN_RATIO = 0.6;
export const PADDING_MAX_RATIO = 0.25;

/** Full check for a prayer that may be shown to mutuals. Returns the cleaned text. */
export function checkPrayer(raw: unknown): Verdict {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' };
  if (raw.length > C.PRAYER_MAX_CHARS * 4) return { ok: false, reason: 'too_long' };
  const text = cleanText(raw);
  if (!text) return { ok: false, reason: 'empty' };
  if ([...text].length > C.PRAYER_MAX_CHARS) return { ok: false, reason: 'too_long' };
  if (leakShaped(text)) return { ok: false, reason: 'leak_shaped' };
  if (denied(text)) return { ok: false, reason: 'denylist' };
  if (latinRatio(text) < LATIN_MIN_RATIO) return { ok: false, reason: 'not_latin' };
  if (compressionRatio(text) < PADDING_MAX_RATIO) return { ok: false, reason: 'padding' };
  return { ok: true, text };
}

/** Intentions: cleaned, at most 140 characters, denylist. Only ever shown to the owner. */
export function checkIntention(raw: unknown): Verdict {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' };
  if (raw.length > C.INTENTION_MAX_CHARS * 4) return { ok: false, reason: 'too_long' };
  const text = cleanText(raw);
  if (!text) return { ok: false, reason: 'empty' };
  if ([...text].length > C.INTENTION_MAX_CHARS) return { ok: false, reason: 'too_long' };
  if (denied(text)) return { ok: false, reason: 'denylist' };
  return { ok: true, text };
}

export const DISPLAY_NAME_MAX = 40;

/** A GitHub display name usable as a public label, or '' if it is not usable. */
export function cleanDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = [...cleanText(raw)].slice(0, DISPLAY_NAME_MAX).join('').trim();
  if (!text || denied(text)) return '';
  return text;
}

/** GitHub logins: 1–39 of [A-Za-z0-9-]. */
export function validLogin(login: unknown): login is string {
  return typeof login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(login);
}
