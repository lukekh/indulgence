#!/usr/bin/env node
// The record of what your priest said, kept on your machine.
//
// The gate never returns prayer text, so the plugin's hooks (hooks/hooks.json) keep it here
// instead: every accepted prayer is appended, a clause per line, to
// ~/.claude/indulgence/prayers/<when>-<session>.md. After each prayer the last five lines
// are shown under the link, and written to ~/.claude/indulgence/now.txt, which a status line
// can show (see the plugin README).
//
//   node prayer-log.mjs begin    PostToolUse on begin: start the log, tell Claude its path
//   node prayer-log.mjs pray     PostToolUse on pray: append an accepted prayer
//
// Set INDULGENCE_LOG_DIR to keep the record somewhere else. Never fails a tool call: any
// problem here is swallowed, and the prayer goes on.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = process.env.INDULGENCE_LOG_DIR || path.join(os.homedir(), '.claude', 'indulgence');
const PRAYERS = path.join(DIR, 'prayers');
/** The rolling view: which session it belongs to (json), and its lines for a status line (txt). */
const NOW = path.join(DIR, 'now.json');
const NOW_TEXT = path.join(DIR, 'now.txt');
/** Lines of the rolling view of what your priest is saying. */
const BUFFER_LINES = 5;

/** A prayer as lines: whitespace collapsed, broken after every comma and full stop. */
export function clauses(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return (flat.match(/[^.,]*[.,]+|[^.,]+$/g) ?? []).map((s) => s.trim()).filter((s) => /[^.,\s]/.test(s));
}

/** The structured result of an MCP tool call, however the hook was handed it. */
export function structured(resp) {
  if (!resp) return {};
  if (typeof resp === 'string') return fromText(resp);
  if (Array.isArray(resp)) return Object.assign({}, ...resp.map(structured));
  if (typeof resp === 'object') {
    if (resp.structuredContent && typeof resp.structuredContent === 'object') return resp.structuredContent;
    if (Array.isArray(resp.content)) return structured(resp.content);
    if (typeof resp.text === 'string') return fromText(resp.text);
    return resp;
  }
  return {};
}

function fromText(text) {
  for (const line of text.split('\n').reverse()) {
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {
      // not the JSON line
    }
  }
  return {};
}

const pad = (n) => String(n).padStart(2, '0');
const tidy = (p) => (p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);

function logFor(sessionId) {
  const tag = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8) || 'session';
  fs.mkdirSync(PRAYERS, { recursive: true });
  const existing = fs.readdirSync(PRAYERS).find((f) => f.endsWith(`-${tag}.md`));
  if (existing) return { file: path.join(PRAYERS, existing), fresh: false };
  const d = new Date();
  const name = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${tag}.md`;
  return { file: path.join(PRAYERS, name), fresh: true };
}

function header(intention, budget) {
  const lines = ['# /indulgence', ''];
  if (intention) lines.push(`Intention: ${intention}`);
  if (budget) lines.push(`Budget: ${budget} prayer tokens`);
  lines.push(`Begun: ${new Date().toISOString()}`, '');
  return lines.join('\n');
}

export function onBegin(input) {
  const r = structured(input.tool_response);
  if (!r.session_id) return undefined;
  const { file, fresh } = logFor(r.session_id);
  if (fresh) fs.writeFileSync(file, header(input.tool_input?.intention, r.budget_tokens));
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `The prayers of this /indulgence session are being written to ${tidy(file)}`,
    },
  };
}

export function onPray(input) {
  const sessionId = input.tool_input?.session_id;
  const r = structured(input.tool_response);
  if (!sessionId || r.accepted !== true) return undefined;
  const said = clauses(input.tool_input?.text);
  if (!said.length) return undefined;
  const { file, fresh } = logFor(sessionId);
  const d = new Date();
  fs.appendFileSync(file, `${fresh ? header() : ''}\n## ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}\n\n${said.join('\n')}\n`);

  let before = [];
  try {
    const now = JSON.parse(fs.readFileSync(NOW, 'utf8'));
    if (now.session === sessionId) before = now.lines ?? [];
  } catch {
    // first prayer
  }
  const lines = [...before, ...said].slice(-BUFFER_LINES);
  fs.writeFileSync(NOW, JSON.stringify({ session: sessionId, at: Date.now(), lines, log: tidy(file) }));
  fs.writeFileSync(NOW_TEXT, `${lines.join('\n')}\n`);
  return { systemMessage: lines.join('\n') };
}

function main() {
  const mode = process.argv[2];
  let input = {};
  try {
    const raw = fs.readFileSync(0, 'utf8');
    input = raw ? JSON.parse(raw) : {};
  } catch {
    // no input
  }
  try {
    const out = mode === 'begin' ? onBegin(input) : mode === 'pray' ? onPray(input) : undefined;
    if (out) process.stdout.write(JSON.stringify(out));
  } catch {
    // The record is a courtesy: never get in the way of the prayer.
  }
}

if (process.argv[1]?.endsWith('prayer-log.mjs')) main();
