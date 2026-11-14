import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import plugin, { IndulgencePlugin, clauses, configure, gateTool, record, resultOf } from './index.js';

test('adds the gate and the command, and leaves alone what is already set', () => {
  const c = configure({ mcp: { other: {} } });
  assert.deepEqual(c.mcp.indulgence, { type: 'remote', url: 'https://indulgence-gate.fly.dev/mcp', enabled: true });
  assert.ok(c.command.indulgence.template.includes('$ARGUMENTS'));
  assert.equal(configure({ mcp: { indulgence: { type: 'remote', url: 'x' } } }).mcp.indulgence.url, 'x');
  assert.equal(configure({}, { gateUrl: 'http://localhost:8787/' }).mcp.indulgence.url, 'http://localhost:8787/mcp');
  assert.equal(plugin.id, 'indulgence');
});

test('knows the gate\'s tools by name and reads their results', () => {
  assert.equal(gateTool('indulgence_pray'), 'pray');
  assert.equal(gateTool('indulgence_begin'), 'begin');
  assert.equal(gateTool('mcp__indulgence__pray'), 'pray');
  assert.equal(gateTool('indulgence_depart'), undefined);
  assert.equal(gateTool('bash'), undefined);
  assert.deepEqual(resultOf('Watch your priest: x\n{"session_id":"abc","mode":"pray"}'), { session_id: 'abc', mode: 'pray' });
  assert.deepEqual(resultOf('no json here'), {});
  assert.deepEqual(clauses('Pater noster, qui es\n in caelis. Amen'), ['Pater noster,', 'qui es in caelis.', 'Amen']);
});

test('keeps a record of accepted prayers on this machine, and nothing else', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'indulgence-'));
  const now = new Date(2026, 10, 14, 9, 5);
  const begun = record('indulgence_begin', { intention: 'for my   cat' }, 'Watch your priest: http://x/#t=secret\n{"session_id":"sess1234XYZ","url":"http://x/#t=secret","mode":"pray"}', { dir, now });
  assert.equal(begun, path.join(dir, 'prayers', '2026-11-14-0905-sess1234.md'));
  // An accepted prayer is appended; a refused one and another tool's call are not.
  assert.equal(record('indulgence_pray', { session_id: 'sess1234XYZ', text: 'Kyrie eleison, Christe eleison. Amen.', tier: 'in_session' }, '{"done":false,"accepted":true,"left":900}', { dir, now }), begun);
  assert.equal(record('indulgence_pray', { session_id: 'sess1234XYZ', text: 'Refused prayer.', tier: 'in_session' }, '{"done":false,"accepted":false,"left":900}', { dir, now }), undefined);
  assert.equal(record('bash', { command: 'ls' }, 'files', { dir, now }), undefined);
  const text = fs.readFileSync(begun, 'utf8');
  assert.equal(text, '# Indulgence\n\nIntention: for my cat\nBegun: ' + now.toISOString() + '\n\nKyrie eleison,\nChriste eleison.\nAmen.\n\n');
  assert.ok(!text.includes('secret'), 'the single-use link is not kept');
  // The hook itself never throws, whatever it is handed.
  const hooks = await IndulgencePlugin({}, undefined);
  await hooks['tool.execute.after'](undefined, undefined);
  await hooks['tool.execute.after']({ tool: 'indulgence_pray', args: null }, { output: null });
  fs.rmSync(dir, { recursive: true, force: true });
});
