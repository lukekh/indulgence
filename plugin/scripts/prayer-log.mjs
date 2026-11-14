#!/usr/bin/env node
// The record of what your priest said, kept on your machine.
//
// The gate never returns prayer text, so the plugins keep it here instead: every accepted
// prayer is appended, a clause per line, to ~/.indulgence/prayers/<when>-<session>.md. The
// last five lines are also written to ~/.indulgence/now.txt, which a status line can show
// (see the Claude Code plugin's README).
//
// Every plugin uses this same file. Each plugin is installed on its own, so each carries a
// copy: this one (plugin/scripts/) is the original, and codex-plugin/scripts/,
// antigravity-plugin/scripts/ and opencode-plugin/ hold identical copies. A test fails if
// they differ; `npm run sync:prayer-log` from the repo root copies this one over them.
//
// As a hook, given the hook's JSON on stdin:
//
//   node prayer-log.mjs begin        Claude Code, Codex: PostToolUse on begin. Starts the
//                                    log, and tells the agent its path.
//   node prayer-log.mjs pray         Claude Code, Codex: PostToolUse on pray. Appends an
//                                    accepted prayer, and shows the last five lines said.
//   node prayer-log.mjs antigravity  Antigravity: PostToolUse on MCP tools. Antigravity hands
//                                    a hook the call but not its result, so the result is
//                                    read from where Antigravity saves it, if it can be found.
//
// The OpenCode plugin imports it instead (begun, prayed).
//
// Set INDULGENCE_LOG_DIR to keep the record somewhere else. Never fails a tool call: any
// problem here is swallowed, and the prayer goes on. Nothing here is sent anywhere.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Lines of the rolling view of what your priest is saying. */
const BUFFER_LINES = 5;

/** Where the record is kept: prayers/ for the logs, now.json and now.txt for the rolling view. */
export function logDir(env = process.env) {
  return env.INDULGENCE_LOG_DIR || path.join(os.homedir(), '.indulgence');
}

/** A prayer as lines: whitespace collapsed, broken after every comma and full stop. */
export function clauses(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return (flat.match(/[^.,]*[.,]+|[^.,]+$/g) ?? []).map((s) => s.trim()).filter((s) => /[^.,\s]/.test(s));
}

const isResult = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && ('session_id' in v || 'accepted' in v || 'done' in v);

/**
 * The structured result of a gate tool call, however the agent wraps it: an MCP result with
 * structuredContent, its content array, the text alone (template lines, then a JSON line),
 * or any of these inside another object. {} if there is none.
 */
export function structured(resp, depth = 0) {
  if (resp == null || depth > 6) return {};
  if (typeof resp === 'string') return fromText(resp);
  if (Array.isArray(resp)) {
    for (const item of resp) {
      const r = structured(item, depth + 1);
      if (isResult(r)) return r;
    }
    return {};
  }
  if (typeof resp !== 'object') return {};
  if (isResult(resp)) return resp;
  if (isResult(resp.structuredContent)) return resp.structuredContent;
  for (const v of Object.values(resp)) {
    const r = structured(v, depth + 1);
    if (isResult(r)) return r;
  }
  return {};
}

function fromText(text) {
  for (const line of String(text).split('\n').reverse()) {
    try {
      const v = JSON.parse(line);
      if (isResult(v)) return v;
    } catch {
      // not the JSON line
    }
  }
  return {};
}

const pad = (n) => String(n).padStart(2, '0');
const tidy = (p) => (p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);

/** The log for a session, found by its tag so that every hook process finds the same one. */
function logFor(sessionId, dir, now) {
  const tag = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 8) || 'session';
  const prayers = path.join(dir, 'prayers');
  fs.mkdirSync(prayers, { recursive: true });
  const existing = fs.readdirSync(prayers).find((f) => f.endsWith(`-${tag}.md`));
  if (existing) return { file: path.join(prayers, existing), fresh: false };
  const name = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}-${tag}.md`;
  return { file: path.join(prayers, name), fresh: true };
}

function header(now, intention, budget) {
  const lines = ['# /indulgence', ''];
  const said = String(intention ?? '').replace(/\s+/g, ' ').trim();
  if (said) lines.push(`Intention: ${said}`);
  if (budget) lines.push(`Budget: ${budget} prayer tokens`);
  lines.push(`Begun: ${now.toISOString()}`, '');
  return lines.join('\n');
}

/** A session has begun: start its log, unless it has one. Returns the log's path. */
export function begun({ sessionId, intention, budget }, { dir = logDir(), now = new Date() } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return undefined;
  const { file, fresh } = logFor(sessionId, dir, now);
  if (fresh) fs.writeFileSync(file, header(now, intention, budget));
  return file;
}

/**
 * The gate accepted a prayer: append it to the session's log and update the rolling view.
 * Returns the log's path and the last few lines said, or undefined if there was nothing to say.
 */
export function prayed({ sessionId, text }, { dir = logDir(), now = new Date() } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return undefined;
  const said = clauses(text);
  if (!said.length) return undefined;
  const { file, fresh } = logFor(sessionId, dir, now);
  fs.appendFileSync(file, `${fresh ? header(now) : ''}\n## ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}\n\n${said.join('\n')}\n`);

  const nowJson = path.join(dir, 'now.json');
  let before = [];
  try {
    const view = JSON.parse(fs.readFileSync(nowJson, 'utf8'));
    if (view.session === sessionId) before = view.lines ?? [];
  } catch {
    // first prayer
  }
  const lines = [...before, ...said].slice(-BUFFER_LINES);
  fs.writeFileSync(nowJson, JSON.stringify({ session: sessionId, at: now.getTime(), lines, log: tidy(file) }));
  fs.writeFileSync(path.join(dir, 'now.txt'), `${lines.join('\n')}\n`);
  return { file, lines };
}

// ---------------------------------------------------------------------------
// Claude Code and Codex: { tool_name, tool_input, tool_response }
// ---------------------------------------------------------------------------

export function onBegin(input, opts) {
  const r = structured(input?.tool_response);
  const file = begun({ sessionId: r.session_id, intention: input?.tool_input?.intention, budget: r.budget_tokens }, opts);
  if (!file) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `The prayers of this /indulgence session are being written to ${tidy(file)}`,
    },
  };
}

export function onPray(input, opts) {
  if (structured(input?.tool_response).accepted !== true) return undefined;
  const out = prayed({ sessionId: input?.tool_input?.session_id, text: input?.tool_input?.text }, opts);
  return out ? { systemMessage: out.lines.join('\n') } : undefined;
}

// ---------------------------------------------------------------------------
// Antigravity: { toolCall: { name, args }, stepIdx, conversationId, ... }
// ---------------------------------------------------------------------------

function parsed(v) {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/**
 * Which of the gate's tools an Antigravity tool call is, and its arguments. Antigravity calls
 * every MCP tool through one tool, with { ServerName, ToolName, Arguments }, where any of
 * them may arrive JSON-encoded.
 */
export function antigravityCall(toolCall) {
  const args = parsed(toolCall?.args);
  if (!args || typeof args !== 'object') return undefined;
  const server = parsed(args.ServerName ?? args.serverName ?? args.server_name);
  const tool = parsed(args.ToolName ?? args.toolName ?? args.tool_name);
  if (typeof server === 'string' && typeof tool === 'string') {
    if (!/indulgence/i.test(server) || (tool !== 'begin' && tool !== 'pray')) return undefined;
    const a = parsed(args.Arguments ?? args.arguments);
    return { tool, args: a && typeof a === 'object' ? a : {} };
  }
  // A tool named for the gate's tool itself, with the arguments as they are.
  const m = /indulgence.*[/_.:-](begin|pray)$/i.exec(String(toolCall?.name ?? ''));
  return m ? { tool: m[1].toLowerCase(), args } : undefined;
}

/**
 * Where Antigravity saved a step's result: <brain>/<conversation>/.system_generated/steps/<n>/output.txt.
 * The step index may be the tool's own step or the step that called it, so both are tried.
 */
function antigravityResult(input) {
  const roots = new Set();
  if (typeof input.artifactDirectoryPath === 'string') roots.add(input.artifactDirectoryPath);
  const t = typeof input.transcriptPath === 'string' ? input.transcriptPath.indexOf(`${path.sep}.system_generated${path.sep}`) : -1;
  if (t > 0) roots.add(input.transcriptPath.slice(0, t));
  if (typeof input.conversationId === 'string' && /^[A-Za-z0-9-]+$/.test(input.conversationId)) {
    for (const app of ['antigravity-cli', 'antigravity', 'antigravity-ide']) roots.add(path.join(os.homedir(), '.gemini', app, 'brain', input.conversationId));
  }
  const step = Number(input.stepIdx);
  if (!Number.isInteger(step) || step < 0) return undefined;
  for (const root of roots) {
    for (const n of [step, step + 1]) {
      try {
        const r = fromText(fs.readFileSync(path.join(root, '.system_generated', 'steps', String(n), 'output.txt'), 'utf8'));
        if (isResult(r)) return r;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

/**
 * One finished Antigravity tool call. When the result can be found it is honoured: begin
 * starts the log, and a refused prayer is left out. When it cannot, a prayer is kept anyway,
 * since most are accepted, and its log is started without the intention. A failed call is
 * never kept. Returns the log written to, if any.
 */
export function onAntigravity(input, opts) {
  const call = antigravityCall(input?.toolCall);
  if (!call || input.error) return undefined;
  const result = antigravityResult(input);
  if (call.tool === 'begin') {
    return result ? begun({ sessionId: result.session_id, intention: call.args.intention, budget: result.budget_tokens }, opts) : undefined;
  }
  if (result && result.accepted !== true) return undefined;
  return prayed({ sessionId: call.args.session_id, text: call.args.text }, opts)?.file;
}

// ---------------------------------------------------------------------------

function main() {
  const mode = process.argv[2];
  let input = {};
  try {
    const raw = fs.readFileSync(0, 'utf8');
    input = raw ? JSON.parse(raw) : {};
  } catch {
    // no input
  }
  let out;
  try {
    if (mode === 'begin') out = onBegin(input);
    else if (mode === 'pray') out = onPray(input);
    else if (mode === 'antigravity') onAntigravity(input);
  } catch {
    // The record is a courtesy: never get in the way of the prayer.
  }
  // Antigravity expects an object back, and nothing more.
  if (mode === 'antigravity') process.stdout.write('{}');
  else if (out) process.stdout.write(JSON.stringify(out));
}

if (process.argv[1]?.endsWith('prayer-log.mjs')) main();
