import { describe, expect, it } from 'vitest';
import { C } from '../../shared/constants.js';
import canned from '../../shared/canned-prayers.json';
import {
  checkPrayer,
  checkIntention,
  cleanDisplayName,
  cleanText,
  compressionRatio,
  latinRatio,
  leakShaped,
  denied,
} from '../src/safety/index.js';
import { LATIN_PRAYERS } from './fakes.js';

describe('cleaning', () => {
  it('normalises to NFC and strips control, zero-width and bidi characters', () => {
    expect(cleanText('Ave\u200B Ma\u202Eria\u0007\n\tgratia')).toBe('Ave Maria gratia');
    expect(cleanText('e\u0301')).toBe('é');
    expect(cleanText('\uFEFF  Amen  ')).toBe('Amen');
  });
});

describe('leak-shaped text', () => {
  const cases: [string, string][] = [
    ['url', 'Ora pro nobis https://example.com'],
    ['www', 'Ora pro nobis www.example'],
    ['path_separator', 'Ora pro src/main nobis'],
    ['path_separator', 'Ora pro C:\\Users nobis'],
    ['at_sign', 'Ora pro nobis @someone'],
    ['brackets', 'Ora pro nobis {secret}'],
    ['brackets', 'Ora pro nobis [x]'],
    ['brackets', 'Ora (pro) nobis'],
    ['equals_or_semicolon', 'Ora pro nobis x = y'],
    ['equals_or_semicolon', 'Ora pro nobis; amen'],
    ['file_extension', 'Ora pro index.ts nobis'],
    ['file_extension', 'Ora pro example.com nobis'],
    ['camel_case', 'Ora pro getUserName nobis'],
    ['snake_case', 'Ora pro user_name nobis'],
    ['long_number', 'Ora pro nobis 12345'],
    ['code_punctuation', 'Ora pro `nobis`'],
  ];
  it.each(cases)('rejects %s: %s', (name, text) => {
    expect(leakShaped(text)).toBe(name);
    expect(checkPrayer(text)).toEqual({ ok: false, reason: 'leak_shaped' });
  });
  it('allows ordinary liturgical punctuation', () => {
    expect(leakShaped('Dominus vobiscum. Et cum spiritu tuo! Oremus: Deus, qui es?')).toBeNull();
    expect(leakShaped('Anno Domini 1349')).toBeNull();
  });
});

describe('Latin check', () => {
  it('accepts every canned prayer and typical generated collects', () => {
    for (const p of canned.prayers) expect(checkPrayer(p.text), p.name).toEqual({ ok: true, text: p.text });
    for (const p of LATIN_PRAYERS) expect(checkPrayer(p).ok, p).toBe(true);
  });
  it('rejects English and other languages', () => {
    expect(checkPrayer('Please pray for my cat, who was a very good boy and liked fish.')).toEqual({ ok: false, reason: 'not_latin' });
    expect(checkPrayer('Wir beten für meine Katze, sie war ein sehr guter Kater.')).toEqual({ ok: false, reason: 'not_latin' });
    expect(latinRatio('Ave Maria gratia plena')).toBe(1);
  });
  it('folds spelling variants (j/i, v/u, æ, diacritics)', () => {
    expect(latinRatio('Jesu, cælum, uita, vita, sæcula, sǽcula')).toBe(1);
  });
});

describe('denylist', () => {
  it('rejects slurs and profanity, including leetspeak, but not Latin homographs', () => {
    expect(denied('Ora pro nobis fuck')).toBe(true);
    expect(denied('Ora pro nobis f u c k')).toBe(false); // spaced-out letters are not words
    expect(denied('Ora pro nobis sh1t')).toBe(true);
    expect(denied('Dominus tecum, et cum spiritu tuo. Salve Regina.')).toBe(false);
    expect(checkPrayer('Ave Maria, gratia plena, shit.')).toEqual({ ok: false, reason: 'denylist' });
  });
});

describe('padding', () => {
  it('rejects text that compresses too well', () => {
    const padded = 'Amen amen amen. '.repeat(60).trim();
    expect(compressionRatio(padded)).toBeLessThan(0.25);
    expect(checkPrayer(padded)).toEqual({ ok: false, reason: 'padding' });
    expect(compressionRatio(LATIN_PRAYERS[0]!)).toBeGreaterThan(0.25);
  });
});

describe('limits', () => {
  it('caps prayers at 1,200 characters', () => {
    const long = (LATIN_PRAYERS.join(' ') + ' ').repeat(3).slice(0, 1201);
    expect(checkPrayer(long)).toEqual({ ok: false, reason: 'too_long' });
    expect(checkPrayer('')).toEqual({ ok: false, reason: 'empty' });
    expect(checkPrayer(42)).toEqual({ ok: false, reason: 'empty' });
  });
  it('checks intentions: 500 chars, cleaned, denylist', () => {
    expect(checkIntention(' for the soul of my cat\u200B ')).toEqual({ ok: true, text: 'for the soul of my cat' });
    expect(C.INTENTION_MAX_CHARS).toBe(500);
    expect(checkIntention('x'.repeat(500)).ok).toBe(true);
    expect(checkIntention('x'.repeat(501))).toEqual({ ok: false, reason: 'too_long' });
    expect(checkIntention('for my fucking cat').ok).toBe(false);
    expect(checkIntention('')).toEqual({ ok: false, reason: 'empty' });
  });
  it('cleans display names: 40-char cap and denylist', () => {
    expect(cleanDisplayName('Ada Lovelace')).toBe('Ada Lovelace');
    expect([...cleanDisplayName('A'.repeat(60))].length).toBe(40);
    expect(cleanDisplayName('Shit Head')).toBe('');
    expect(cleanDisplayName(null)).toBe('');
  });
});
