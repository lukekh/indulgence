// How a prayer is recited over a priest's head.
//
// A priest says nothing until it has sat down in its pew. Then the prayer is typed out one
// sentence per line: whatever line breaks the model wrote are ignored, and only a full stop
// ends a line. When the next line begins, the one before rises above it at half opacity,
// sways a little and is gone after LINGER_MS, or at once if a third line starts first. The
// last line of one prayer gives way to the first of the next in the same way.

/** How long a finished line lingers above the one being typed. */
export const LINGER_MS = 2000;
/** Typing pace in characters per second; faster only when a prayer would not fit its slot. */
export const CHARS_PER_S = 14;
/** A breath after each full stop, in characters' worth of time. */
const PAUSE_CHARS = 10;
/** Share of the pacing slot a prayer may take to type; the rest it is read in full. */
const TYPE_SHARE = 0.8;
/** The last line fades out over the end of its slot. */
const FADE_OUT_MS = 1500;

/** The prayer as lines: all whitespace collapsed, broken only after full stops. */
export function sentences(text: string): string[] {
  const flat = text.replace(/\s+/g, ' ').trim();
  return (flat.match(/[^.]*\.+|[^.]+$/g) ?? []).map((s) => s.trim()).filter((s) => /[^.\s]/.test(s));
}

export interface Line {
  text: string;
  /** ms when typing begins */
  start: number;
  /** ms when the last character is typed */
  typed: number;
}

export interface Recital {
  lines: Line[];
  start: number;
  /** ms when the prayer has faded out, unless the next one takes over first. */
  end: number;
}

/** Schedule a prayer that begins at `start` and owns a pacing slot of `slotMs`. */
export function schedule(text: string, start: number, slotMs: number): Recital {
  const parts = sentences(text);
  const weight = parts.reduce((n, s) => n + s.length + PAUSE_CHARS, 0);
  const cps = Math.max(CHARS_PER_S, weight / ((slotMs * TYPE_SHARE) / 1000));
  let at = start;
  const lines = parts.map((s) => {
    const line: Line = { text: s, start: at, typed: at + (s.length / cps) * 1000 };
    at += ((s.length + PAUSE_CHARS) / cps) * 1000;
    return line;
  });
  return { lines, start, end: start + slotMs };
}

/** The part of a line typed by time `t`. */
export function typedAt(line: Line, t: number): string {
  if (t >= line.typed) return line.text;
  if (t <= line.start) return '';
  return line.text.slice(0, Math.ceil((line.text.length * (t - line.start)) / (line.typed - line.start)));
}

export interface Spoken {
  /** The line being typed (or just typed), with its full text for layout. */
  current?: { line: Line; shown: string; alpha: number };
  /** The line before it, at half opacity, until LINGER_MS after `since`. */
  previous?: { text: string; since: number; alpha: number };
}

function fade(r: Recital, t: number): number {
  return Math.max(0, Math.min(1, (r.end - t) / FADE_OUT_MS));
}

/** What a priest is saying at `t`, given its current prayer and the one before it. */
export function spokenAt(cur: Recital, prev: Recital | undefined, t: number): Spoken {
  if (t < cur.start || t >= cur.end) return {};
  let i = -1;
  for (let k = 0; k < cur.lines.length && cur.lines[k]!.start <= t; k++) i = k;
  if (i < 0) return {};
  const line = cur.lines[i]!;
  const out: Spoken = { current: { line, shown: typedAt(line, t), alpha: fade(cur, t) } };
  if (t - line.start >= LINGER_MS) return out;
  if (i > 0) {
    out.previous = { text: cur.lines[i - 1]!.text, since: line.start, alpha: 0.5 };
  } else if (prev && prev.end > cur.start) {
    // The line the last prayer was showing when this one began, as far as it had got.
    let j = -1;
    for (let k = 0; k < prev.lines.length && prev.lines[k]!.start < cur.start; k++) j = k;
    const text = j >= 0 ? typedAt(prev.lines[j]!, cur.start) : '';
    if (text) out.previous = { text, since: line.start, alpha: 0.5 * fade(prev, cur.start) };
  }
  return out;
}
