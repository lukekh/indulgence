import { describe, expect, it } from 'vitest';
import { sentences, schedule, spokenAt, typedAt, LINGER_MS, CHARS_PER_S } from '../src/recital';

const SLOT = 20_000;

describe('sentences', () => {
  it('breaks only after full stops, whatever the model did with whitespace', () => {
    const text = 'Pater noster, qui es\nin caelis,\n\n   sanctificetur nomen tuum. Adveniat regnum tuum.\nFiat voluntas tua';
    expect(sentences(text)).toEqual(['Pater noster, qui es in caelis, sanctificetur nomen tuum.', 'Adveniat regnum tuum.', 'Fiat voluntas tua']);
  });

  it('keeps ellipses and drops empty fragments', () => {
    expect(sentences('Amen... . Amen.')).toEqual(['Amen...', 'Amen.']);
    expect(sentences('  ')).toEqual([]);
  });

  it('a prayer without a full stop stays on one line', () => {
    expect(sentences('Kyrie eleison, Christe eleison, Kyrie eleison')).toHaveLength(1);
  });
});

describe('schedule', () => {
  it('types at a steady pace, one line after another, inside the slot', () => {
    const r = schedule('Ave Maria, gratia plena. Dominus tecum. Amen.', 1000, SLOT);
    expect(r.lines.map((l) => l.text)).toEqual(['Ave Maria, gratia plena.', 'Dominus tecum.', 'Amen.']);
    expect(r.lines[0]!.start).toBe(1000);
    const l0 = r.lines[0]!;
    expect(l0.typed - l0.start).toBeCloseTo((l0.text.length / CHARS_PER_S) * 1000);
    for (let i = 1; i < r.lines.length; i++) expect(r.lines[i]!.start).toBeGreaterThan(r.lines[i - 1]!.typed);
    expect(r.end).toBe(1000 + SLOT);
  });

  it('speeds up a long prayer so it is typed well before the slot ends', () => {
    const long = Array.from({ length: 12 }, () => 'Sancta Maria, mater Dei, ora pro nobis peccatoribus.').join(' ');
    const r = schedule(long, 0, SLOT);
    expect(r.lines.at(-1)!.typed).toBeLessThan(SLOT * 0.85);
  });

  it('types a line from the left', () => {
    const r = schedule('Gloria Patri.', 0, SLOT);
    const l = r.lines[0]!;
    expect(typedAt(l, -5)).toBe('');
    expect(typedAt(l, (l.typed - l.start) / 2)).toBe('Gloria ');
    expect(typedAt(l, l.typed)).toBe('Gloria Patri.');
  });
});

describe('spokenAt', () => {
  const r = schedule('Ave Maria, gratia plena, Dominus tecum. Benedicta tu. Sancta Maria. Amen.', 0, SLOT);
  const [a, b, c] = r.lines;

  it('says nothing before it begins (the priest is still walking to its pew)', () => {
    expect(spokenAt(r, undefined, -1)).toEqual({});
  });

  it('shows one line while the first sentence is typed', () => {
    const s = spokenAt(r, undefined, 500);
    expect(s.current?.line).toBe(a);
    expect(s.previous).toBeUndefined();
  });

  it('a new line pushes the last one up at half opacity, for two seconds', () => {
    const s = spokenAt(r, undefined, b!.start + 10);
    expect(s.current?.line).toBe(b);
    expect(s.previous).toEqual({ text: a!.text, since: b!.start, alpha: 0.5 });
    const later = spokenAt(r, undefined, b!.start + LINGER_MS + 1);
    if (later.current?.line === b) expect(later.previous).toBeUndefined();
  });

  it('a third line replaces the lingering one at once', () => {
    // "Benedicta tu." is short: the third line starts within two seconds of the second.
    expect(c!.start - b!.start).toBeLessThan(LINGER_MS);
    const s = spokenAt(r, undefined, c!.start + 1);
    expect(s.current?.line).toBe(c);
    expect(s.previous?.text).toBe(b!.text);
  });

  it('the next prayer takes over from where the last one had got to', () => {
    const next = schedule('Gloria Patri. Amen.', 1500, SLOT);
    const s = spokenAt(next, r, 1510);
    expect(s.current?.line.text).toBe('Gloria Patri.');
    // Cut off mid-sentence: what had been typed of it lingers above.
    expect(s.previous?.text).toBe(typedAt(a!, 1500));
    expect(s.previous?.text.length).toBeLessThan(a!.text.length);
    // But not a prayer that had already faded out.
    const much = schedule('Gloria Patri.', SLOT + 5000, SLOT);
    expect(spokenAt(much, r, SLOT + 5010).previous).toBeUndefined();
  });

  it('fades out at the end of its slot', () => {
    expect(spokenAt(r, undefined, SLOT - 750).current?.alpha).toBeCloseTo(0.5);
    expect(spokenAt(r, undefined, SLOT)).toEqual({});
  });
});
