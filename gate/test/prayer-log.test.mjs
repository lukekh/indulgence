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

describe('keeping the agent at prayer', () => {
  // Hook input carries the agent's conversation as session_id; the gate's session is in the tool's.
  const conv = 'conv-stop-1';
  const t0 = Date.now();
  const opts = (s) => ({ dir, now: new Date(t0 + s * 1000) });
  const begin = (s, sessionId, mode = 'pray') =>
    log.onBegin({ session_id: conv, tool_input: { intention: 'pro anima mea' }, tool_response: result({ session_id: sessionId, url: 'https://example/v#t', mode, budget_tokens: 5000 }) }, opts(s));
  const pray = (s, sessionId, done = false, accepted = true) =>
    log.onPray({ session_id: conv, tool_input: { session_id: sessionId, text: 'Kyrie eleison.', tier: 'in_session' }, tool_response: result({ done, accepted, left: 100 }) }, opts(s));
  const stop = (s, who = 'codex', conversation = conv) => log.onStop({ session_id: conversation, stop_hook_active: false }, who, opts(s));
  const liveFile = () => path.join(dir, 'live', `${conv}.json`);

  it('sends the agent back while its session is live, and says how to carry on', () => {
    begin(0, 'liveLIVE-0001');
    const first = stop(5);
    expect(first.decision).toBe('block');
    expect(first.reason).toContain('compose the next prayer and call pray with session_id liveLIVE-0001');
    expect(first.reason).toContain('wait on it instead');
    expect(first.reason).toContain('3 minutes of silence');
    expect(first.reason).toContain('call depart');
    const claude = stop(6, 'claude-code');
    expect(claude.reason).toContain('launch a fresh priest subagent');
    expect(claude.reason).not.toContain('script');
    // Sent back at most three times without a new result: an agent that will not go on is let go.
    expect(log.MAX_PUSHES).toBe(3);
    expect(stop(7).decision).toBe('block');
    expect(stop(8)).toBeUndefined();
    // A new result, even a refusal, means it went on.
    pray(30, 'liveLIVE-0001', false, false);
    expect(stop(31).decision).toBe('block');
    // Nothing but the session, when, and whether it is done: no prayer text.
    expect(fs.readFileSync(liveFile(), 'utf8')).not.toContain('Kyrie');
  });

  it('lets the agent stop once its session is done, departed or long silent', () => {
    pray(40, 'liveLIVE-0001', true);
    expect(stop(41)).toBeUndefined();
    expect(fs.existsSync(liveFile())).toBe(false);

    begin(50, 'liveLIVE-0002');
    log.onDepart({ session_id: conv, tool_input: { session_id: 'liveLIVE-0002' }, tool_response: result({ ok: true }) }, opts(55));
    expect(stop(56)).toBeUndefined();

    begin(60, 'liveLIVE-0003');
    expect(stop(60 + 179).decision).toBe('block');
    expect(stop(60 + 181)).toBeUndefined();
  });

  it('never sends back another conversation, or a Codex agent after Esc until it prays again', () => {
    begin(100, 'liveLIVE-0004');
    expect(stop(101, 'codex', 'conv-elsewhere')).toBeUndefined();
    expect(log.onStop({}, 'codex', opts(101))).toBeUndefined();
    log.onInterrupt({ session_id: conv }, opts(102));
    expect(stop(103)).toBeUndefined();
    pray(120, 'liveLIVE-0004');
    expect(stop(121).decision).toBe('block');
  });

  it('goes on with vigil in sampling mode, and ignores results for another session', () => {
    begin(200, 'sampSAMP-0005', 'sampling');
    expect(stop(201).reason).toContain('call vigil again with session_id sampSAMP-0005');
    // An old session's last result does not end the live one.
    pray(205, 'liveLIVE-0004', true);
    expect(stop(206).decision).toBe('block');
    // The gate fell back from sampling to pray.
    log.onVigil({ session_id: conv, tool_input: { session_id: 'sampSAMP-0005' }, tool_response: result({ done: false, mode: 'pray', prayers: 0, spent: 0, left: 5000 }) }, opts(210));
    expect(stop(211).reason).toContain('call pray with session_id sampSAMP-0005');
  });

  it('clears away what conversations long gone left behind', () => {
    const old = path.join(dir, 'live', 'conv-long-gone.json');
    fs.writeFileSync(old, JSON.stringify({ session: 'goneGONE-1', at: t0, done: false, next: 'pray', pushes: 0 }));
    fs.utimesSync(old, new Date(t0 - 25 * 3600_000), new Date(t0 - 25 * 3600_000));
    stop(300, 'codex', 'conv-anyone');
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(liveFile())).toBe(true);
  });

  it('counts a session live for as long as the gate waits for a silent priest', () => {
    const constants = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../shared/constants.json'), 'utf8'));
    expect(log.LIVE_FOR_MS).toBe(constants.SILENCE_DEPART_MS);
  });

  it('answers Stop the way Claude Code and Codex expect, and never fails', () => {
    const script = path.resolve(import.meta.dirname, '../../plugin/scripts/prayer-log.mjs');
    const run = (args, input) => spawnSync(process.execPath, [script, ...args], { input, env: { ...process.env, INDULGENCE_LOG_DIR: dir } });
    log.noted({ conversation: 'conv-cli', sessionId: 'cliCLI-01', done: false, next: 'pray', fresh: true }, { dir });
    const r = run(['stop', 'codex'], JSON.stringify({ session_id: 'conv-cli', hook_event_name: 'Stop', stop_hook_active: false }));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.toString())).toEqual({ decision: 'block', reason: expect.stringContaining('cliCLI-01') });
    for (const [args, input] of [[['stop', 'claude-code'], ''], [['stop'], 'not json'], [['interrupt'], '{}'], [['vigil'], '{"session_id":"x"}'], [['depart'], '']]) {
      const q = run(args, input);
      expect(q.status).toBe(0);
      expect(q.stdout.toString()).toBe('');
    }
  });

  it('is wired to every gate tool, and to Stop, in the Claude Code and Codex plugins', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const commands = (file, event) =>
      (JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).hooks[event] ?? []).flatMap((g) => g.hooks.map((h) => h.command.replace(/^.*prayer-log\.mjs" /, '')));
    expect(commands('plugin/hooks/hooks.json', 'PostToolUse')).toEqual(['begin', 'pray', 'vigil', 'depart']);
    expect(commands('plugin/hooks/hooks.json', 'Stop')).toEqual(['stop claude-code']);
    expect(commands('codex-plugin/hooks/hooks.json', 'PostToolUse')).toEqual(['begin', 'pray', 'vigil', 'depart']);
    expect(commands('codex-plugin/hooks/hooks.json', 'Stop')).toEqual(['stop codex']);
    expect(commands('codex-plugin/hooks/hooks.json', 'Interrupt')).toEqual(['interrupt']);
  });
});
