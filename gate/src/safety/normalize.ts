// Text normalisation shared by the runtime filters and the data build scripts.

// Zero-width characters and bidi controls.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩؜﻿­᠎]/gu;
// C0/C1 controls (tabs and newlines included; they become spaces first).
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/gu;

/**
 * NFC normalisation, then strip control, zero-width and bidi characters.
 * Whitespace runs collapse to one space; leading and trailing space is removed.
 */
export function cleanText(input: string): string {
  return input
    .normalize('NFC')
    .replace(/[\t\n\r\v\f]+/g, ' ')
    .replace(CONTROL, '')
    .replace(INVISIBLE, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Fold a word for dictionary lookup: lower case, strip diacritics, æ→ae, œ→oe,
 * j→i, v→u (classical and ecclesiastical spellings vary).
 */
export function foldLatin(word: string): string {
  return word
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/j/g, 'i')
    .replace(/v/g, 'u');
}

/** Words as runs of letters. */
export function words(text: string): string[] {
  return text.match(/\p{L}+/gu) ?? [];
}

const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '$': 's',
  '!': 'i',
  '|': 'i',
  '+': 't',
};

/** Fold a string for denylist matching: lower case, no diacritics, leetspeak undone. */
export function foldForDenylist(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[01345789$!|+]/g, (ch) => LEET[ch] ?? ch);
}

/** Tokens for denylist matching (letters only, after folding). */
export function denylistTokens(text: string): string[] {
  return foldForDenylist(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}
