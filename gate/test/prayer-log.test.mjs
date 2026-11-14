// The plugins' local record of prayers (plugin/scripts/prayer-log.mjs), fed hook input in the
// shapes Claude Code, Codex and Antigravity hand it. Plain JS: the script is plain JS too.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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
    expect(log.structured({ Ok: { content: result(s).content } })).toEqual(s);
    expect(log.structured(undefined)).toEqual({});
    expect(log.structured('no json here')).toEqual({});
  });

  it('keeps the record in ~/.indulgence unless told otherwise', () => {
    expect(log.logDir({})).toBe(path.join(os.homedir(), '.indulgence'));
    expect(log.logDir({ INDULGENCE_LOG_DIR: '/elsewhere' })).toBe('/elsewhere');
  });

  it('is the same script in every plugin', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const original = fs.readFileSync(path.join(root, 'plugin/scripts/prayer-log.mjs'), 'utf8');
    for (const copy of ['codex-plugin/scripts/prayer-log.mjs', 'antigravity-plugin/scripts/prayer-log.mjs', 'opencode-plugin/prayer-log.mjs']) {
      expect(fs.readFileSync(path.join(root, copy), 'utf8'), `${copy} differs: run npm run sync:prayer-log`).toBe(original);
    }
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

  describe('from Antigravity', () => {
    // Antigravity saves each step's result here, and hands the hook only the call.
    const brain = path.join(dir, 'brain', 'conv-1');
    const saved = (step, structuredResult) => {
      fs.mkdirSync(path.join(brain, '.system_generated', 'steps', String(step)), { recursive: true });
      fs.writeFileSync(path.join(brain, '.system_generated', 'steps', String(step), 'output.txt'), `Created At: x\nCompleted At: y\n${JSON.stringify(structuredResult)}`);
    };
    const call = (tool, args, stepIdx, extra = {}) => ({
      toolCall: { id: 'call_1', name: 'call_mcp_tool', args: { ServerName: '"indulgence_indulgence"', ToolName: `"${tool}"`, Arguments: JSON.stringify(args) } },
      stepIdx,
      conversationId: 'conv-1',
      artifactDirectoryPath: brain,
      hookEventName: 'PostToolUse',
      ...extra,
    });
    const logOf = (tag) => fs.readFileSync(path.join(dir, 'prayers', fs.readdirSync(path.join(dir, 'prayers')).find((f) => f.endsWith(`-${tag}.md`))), 'utf8');

    it('knows the gate\'s tools from Antigravity\'s one MCP tool, however the arguments arrive', () => {
      expect(log.antigravityCall({ name: 'call_mcp_tool', args: { ServerName: 'indulgence_indulgence', ToolName: 'pray', Arguments: { session_id: 's', text: 't' } } })).toEqual({ tool: 'pray', args: { session_id: 's', text: 't' } });
      expect(log.antigravityCall({ name: 'mcp_tool', args: JSON.stringify({ ServerName: 'indulgence', ToolName: 'begin', Arguments: '{"intention":"x"}' }) })).toEqual({ tool: 'begin', args: { intention: 'x' } });
      expect(log.antigravityCall({ name: 'indulgence_indulgence/pray', args: { session_id: 's' } })).toEqual({ tool: 'pray', args: { session_id: 's' } });
      expect(log.antigravityCall({ name: 'call_mcp_tool', args: { ServerName: 'indulgence_indulgence', ToolName: 'depart', Arguments: '{}' } })).toBeUndefined();
      expect(log.antigravityCall({ name: 'call_mcp_tool', args: { ServerName: 'github', ToolName: 'pray', Arguments: '{}' } })).toBeUndefined();
      expect(log.antigravityCall({ name: 'run_command', args: { CommandLine: 'ls' } })).toBeUndefined();
      expect(log.antigravityCall(undefined)).toBeUndefined();
    });

    it('starts the log on begin, from the saved result', () => {
      saved(4, { session_id: 'agyAGY12-xyz', url: 'https://example/v#t=secret', mode: 'pray', budget_tokens: 5000 });
      expect(log.onAntigravity(call('begin', { intention: 'pro anima mea', budget_tokens: 5000 }, 4))).toMatch(/-agyAGY12\.md$/);
      expect(logOf('agyAGY12')).toContain('Intention: pro anima mea');
      expect(logOf('agyAGY12')).not.toContain('secret');
    });

    it('keeps accepted prayers and leaves out refused or failed ones', () => {
      saved(6, { done: false, accepted: true, left: 4000 });
      saved(8, { done: false, accepted: false, left: 4000 });
      // The step index may be the calling step, one before the tool's own.
      saved(11, { done: false, accepted: true, left: 3000 });
      expect(log.onAntigravity(call('pray', { session_id: 'agyAGY12-xyz', text: 'Kyrie eleison. Amen.', tier: 'in_session' }, 6))).toBeDefined();
      expect(log.onAntigravity(call('pray', { session_id: 'agyAGY12-xyz', text: 'Refusa oratio.' }, 8))).toBeUndefined();
      expect(log.onAntigravity(call('pray', { session_id: 'agyAGY12-xyz', text: 'Fracta oratio.' }, 9, { error: 'timeout' }))).toBeUndefined();
      expect(log.onAntigravity(call('pray', { session_id: 'agyAGY12-xyz', text: 'Christe eleison.' }, 10))).toBeDefined();
      const text = logOf('agyAGY12');
      expect(text).toContain('Kyrie eleison.\nAmen.');
      expect(text).toContain('Christe eleison.');
      expect(text).not.toContain('Refusa');
      expect(text).not.toContain('Fracta');
    });

    it('keeps a prayer whose result it cannot find, since most are accepted', () => {
      expect(log.onAntigravity(call('pray', { session_id: 'lostRSLT-1', text: 'Gloria Patri.' }, 40, { artifactDirectoryPath: undefined, conversationId: 'no-such-conversation' }))).toBeDefined();
      expect(logOf('lostRSLT')).toContain('Gloria Patri.');
      expect(log.onAntigravity(call('begin', { intention: 'x' }, 41, { artifactDirectoryPath: undefined, conversationId: 'no-such-conversation' }))).toBeUndefined();
    });

    it('never fails, and always answers Antigravity with an empty object', () => {
      const script = path.resolve(import.meta.dirname, '../../plugin/scripts/prayer-log.mjs');
      for (const stdin of ['', 'not json', JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } })]) {
        const r = spawnSync(process.execPath, [script, 'antigravity'], { input: stdin, env: { ...process.env, INDULGENCE_LOG_DIR: dir } });
        expect(r.status).toBe(0);
        expect(r.stdout.toString()).toBe('{}');
      }
    });
  });
});
