// The plugin's local record of prayers (plugin/scripts/prayer-log.mjs), fed tool results in
// the shapes the gate returns them. Plain JS: the script is plain JS too.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'indulgence-log-'));
let log;

beforeAll(async () => {
  process.env.INDULGENCE_LOG_DIR = dir;
  log = await import('../../plugin/scripts/prayer-log.mjs');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A tool result as the gate's ok() builds it: template lines, then the JSON. */
const result = (structured, lines = []) => ({
  content: [{ type: 'text', text: [...lines, JSON.stringify(structured)].join('\n') }],
  structuredContent: structured,
});

describe('prayer log', () => {
  it('breaks a prayer into clauses at commas and full stops', () => {
    expect(log.clauses('Deus, qui omnia\ncreasti,  suscipe animam. Amen')).toEqual(['Deus,', 'qui omnia creasti,', 'suscipe animam.', 'Amen']);
  });

  it('reads the structured result however the hook is handed it', () => {
    const s = { done: false, accepted: true, left: 9000 };
    expect(log.structured(result(s, ['Accepted.']))).toEqual(s);
    expect(log.structured(result(s).content)).toEqual(s);
    expect(log.structured(result(s).content[0].text)).toEqual(s);
    expect(log.structured(undefined)).toEqual({});
  });

  it('starts a log on begin and tells Claude where it is', () => {
    const out = log.onBegin({
      tool_input: { intention: 'for the soul of my cat', budget_tokens: 20000 },
      tool_response: result({ session_id: 'feedbeef-0000', url: 'https://example/v#t', mode: 'pray', budget_tokens: 20000 }, ['Your priest is entering.']),
    });
    const files = fs.readdirSync(path.join(dir, 'prayers'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/-feedbeef\.md$/);
    expect(out.hookSpecificOutput.additionalContext).toContain(files[0]);
    expect(fs.readFileSync(path.join(dir, 'prayers', files[0]), 'utf8')).toContain('Intention: for the soul of my cat');
  });

  it('records accepted prayers, and shows the last five lines said', () => {
    const pray = (text, accepted = true) =>
      log.onPray({ tool_input: { session_id: 'feedbeef-0000', text, tier: 'subagent' }, tool_response: result({ done: false, accepted, left: 1 }) });
    expect(pray('Deus, qui omnia animalia creasti. Amen.').systemMessage.split('\n')).toEqual(['Deus,', 'qui omnia animalia creasti.', 'Amen.']);
    expect(pray('nonsense', false)).toBeUndefined();
    const out = pray('Requiem aeternam dona ei, Domine, et lux perpetua luceat ei.');
    expect(out.systemMessage.split('\n')).toEqual(['qui omnia animalia creasti.', 'Amen.', 'Requiem aeternam dona ei,', 'Domine,', 'et lux perpetua luceat ei.']);
    expect(fs.readFileSync(path.join(dir, 'now.txt'), 'utf8')).toBe(`${out.systemMessage}\n`);

    const [file] = fs.readdirSync(path.join(dir, 'prayers'));
    const text = fs.readFileSync(path.join(dir, 'prayers', file), 'utf8');
    expect(text).toContain('Deus,\nqui omnia animalia creasti.\nAmen.');
    expect(text).toContain('Requiem aeternam dona ei,\nDomine,');
    expect(text).not.toContain('nonsense');
  });

  it('starts the view afresh for another session', () => {
    const out = log.onPray({ tool_input: { session_id: 'cafebabe-1111', text: 'Gloria Patri.' }, tool_response: result({ done: true, accepted: true, left: 0 }) });
    expect(out.systemMessage).toBe('Gloria Patri.');
    expect(fs.readdirSync(path.join(dir, 'prayers')).some((f) => f.endsWith('-cafebabe.md'))).toBe(true);
  });
});
