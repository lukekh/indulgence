// The remote MCP server: five tools, no resources.
//
// Every tool result is a fixed template filled with numbers, ids and the viewer URL. No
// result contains prayer text, intentions, names, argument values or rejection reasons.
// Arguments are validated by hand (not by a schema library) so validation errors cannot
// echo input back to the model.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { C } from '../../shared/constants.js';
import type { Account, ErrorCode, SessionManager, Sampler } from './sessions.js';

export const SERVER_NAME = 'indulgence';
export const SERVER_VERSION = '0.1.0';

/** A typical prayer is ~600 characters, so the default 10,000-token budget is ~50 prayers. */
const AVG_PRAYER_TOKENS = 200;

const bool = { type: 'boolean' } as const;
const int = { type: 'integer' } as const;
const str = { type: 'string' } as const;

export const TOOLS: Tool[] = [
  {
    name: 'begin',
    description:
      'Start an /indulgence session. intention: the user\'s words, verbatim, at most 140 characters. ' +
      `budget_tokens: prayer-token budget, ${C.BUDGET_MIN}–${C.BUDGET_MAX}, default ${C.BUDGET_DEFAULT}. ` +
      'share_prayers: default true, so mutuals can read the prayers; false keeps them private, and everyone else sees only pre-generated prayers. ' +
      'Returns session_id, url, mode ("sampling" or "pray"), budget_tokens and share_prayers.',
    inputSchema: {
      type: 'object',
      properties: {
        intention: { type: 'string', maxLength: C.INTENTION_MAX_CHARS },
        budget_tokens: { type: 'integer', minimum: C.BUDGET_MIN, maximum: C.BUDGET_MAX, default: C.BUDGET_DEFAULT },
        share_prayers: { type: 'boolean', default: true },
      },
      required: ['intention'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { session_id: str, url: str, mode: { type: 'string', enum: ['sampling', 'pray'] }, budget_tokens: int, share_prayers: bool },
      required: ['session_id', 'url', 'mode', 'budget_tokens', 'share_prayers'],
    },
  },
  {
    name: 'vigil',
    description:
      'Sampling mode only. Runs for up to 5 minutes while the server requests prayers from this client. ' +
      'Returns done, mode, prayers, spent and left.',
    inputSchema: {
      type: 'object',
      properties: { session_id: str },
      required: ['session_id'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { done: bool, mode: { type: 'string', enum: ['sampling', 'pray'] }, prayers: int, spent: int, left: int },
      required: ['done', 'mode', 'prayers', 'spent', 'left'],
    },
  },
  {
    name: 'pray',
    description:
      `Submit one Latin prayer (at most ${C.PRAYER_MAX_CHARS} characters) for a session. ` +
      'tier: "subagent" or "in_session". Returns done, accepted and left.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: str,
        text: { type: 'string', maxLength: C.PRAYER_MAX_CHARS },
        tier: { type: 'string', enum: ['subagent', 'in_session'] },
      },
      required: ['session_id', 'text', 'tier'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { done: bool, accepted: bool, left: int },
      required: ['done', 'accepted', 'left'],
    },
  },
  {
    name: 'depart',
    description: 'End a session. The priest lights a candle and leaves.',
    inputSchema: {
      type: 'object',
      properties: { session_id: str },
      required: ['session_id'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object', properties: { ok: bool }, required: ['ok'] },
  },
  {
    name: 'forget',
    description: 'Delete the signed-in account, its follow edges, sessions and candles.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: { ok: bool }, required: ['ok'] },
  },
];

/** Fixed error texts. Nothing here is ever filled with input. */
export const ERROR_TEXT: Record<ErrorCode | 'unauthenticated' | 'unknown_tool', string> = {
  bad_args: 'Error: invalid arguments.',
  invalid_intention: 'Error: intention not accepted. It must be 1 to 140 characters of plain text.',
  rate_limited: 'Error: too many sessions started in the last hour. Try again later.',
  full: 'Error: the cathedral is full. Try again later.',
  unavailable: 'Error: the cathedral is unavailable. Try again later.',
  no_account: 'Error: account not found. Reconnect the indulgence MCP server to sign in with GitHub again.',
  unauthenticated: 'Error: not signed in. Reconnect the indulgence MCP server to sign in with GitHub.',
  unknown_tool: 'Error: unknown tool.',
};

function ok(structured: Record<string, unknown>, lines?: string[]): CallToolResult {
  const text = lines ? `${lines.join('\n')}\n${JSON.stringify(structured)}` : JSON.stringify(structured);
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function fail(code: keyof typeof ERROR_TEXT): CallToolResult {
  return { content: [{ type: 'text', text: ERROR_TEXT[code] }], isError: true };
}

function asArgs(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : v === undefined ? {} : undefined;
}

export interface ToolContext {
  account?: Account;
  mcpSessionId?: string;
  signal: AbortSignal;
  /** Present when the client declared the sampling capability. */
  sampler?: Sampler;
  progress?: (n: number) => void;
}

/** Dispatch a tool call. Exported separately from the Server so it can be property-tested. */
export async function callTool(sessions: SessionManager, name: string, rawArgs: unknown, ctx: ToolContext): Promise<CallToolResult> {
  if (!TOOLS.some((t) => t.name === name)) return fail('unknown_tool');
  const args = asArgs(rawArgs);
  if (!args) return fail('bad_args');
  const account = ctx.account;
  if (!account) return fail('unauthenticated');

  switch (name) {
    case 'begin': {
      const r = await sessions.begin(account, args, { mode: ctx.sampler ? 'sampling' : 'pray', mcpSessionId: ctx.mcpSessionId });
      if ('error' in r) return fail(r.error);
      const prayers = Math.max(1, Math.round(r.budget_tokens / AVG_PRAYER_TOKENS));
      return ok(
        { session_id: r.session_id, url: r.url, mode: r.mode, budget_tokens: r.budget_tokens, share_prayers: r.share_prayers },
        [
          `Watch your priest: ${r.url}`,
          `Budget: ${r.budget_tokens} prayer tokens (roughly ${prayers} prayers, one every ${C.PACING_SLOT_MS / 1000} seconds).`,
          'Real token usage is roughly 2 to 5 times the prayer-token budget.',
          r.share_prayers
            ? 'Your mutuals can read your prayers; strangers see pre-generated ones. Pass share_prayers: false to keep them private.'
            : 'Sharing is off: everyone else will see only pre-generated prayer text, never your prayers.',
        ],
      );
    }
    case 'vigil': {
      const r = await sessions.vigil(account, args, { signal: ctx.signal, sampler: ctx.sampler, progress: ctx.progress });
      if ('error' in r) return fail(r.error);
      return ok({ done: r.done, mode: r.mode, prayers: r.prayers, spent: r.spent, left: r.left });
    }
    case 'pray': {
      const r = await sessions.pray(account, args, { signal: ctx.signal });
      if ('error' in r) return fail(r.error);
      return ok({ done: r.done, accepted: r.accepted, left: r.left });
    }
    case 'depart': {
      await sessions.depart(account, args);
      return ok({ ok: true });
    }
    case 'forget': {
      const r = await sessions.forget(account);
      if ('error' in r) return fail(r.error);
      return ok({ ok: true });
    }
  }
  return fail('unknown_tool');
}

/** One low-level MCP Server per streamable-HTTP transport session. */
export function createMcpServer(sessions: SessionManager, getMcpSessionId: () => string | undefined): Server {
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const auth = extra.authInfo?.extra as { ghHash?: unknown; viewerSub?: unknown } | undefined;
    const account =
      typeof auth?.ghHash === 'string' && typeof auth.viewerSub === 'string'
        ? { ghHash: auth.ghHash, viewerSub: auth.viewerSub }
        : undefined;

    const sampler: Sampler | undefined = server.getClientCapabilities()?.sampling
      ? async (systemPrompt, userText, opts) => {
          const res = await server.createMessage(
            {
              systemPrompt,
              messages: [{ role: 'user', content: { type: 'text', text: userText } }],
              includeContext: 'none',
              maxTokens: 300,
              temperature: 1,
            },
            { signal: opts.signal, timeout: opts.timeoutMs },
          );
          const content = Array.isArray(res.content) ? res.content[0] : res.content;
          if (!content || content.type !== 'text') throw new Error('non-text sampling result');
          return content.text;
        }
      : undefined;

    const progressToken = extra._meta?.progressToken;
    const progress =
      progressToken !== undefined
        ? (n: number) => {
            void extra
              .sendNotification({ method: 'notifications/progress', params: { progressToken, progress: n } })
              .catch(() => {});
          }
        : undefined;

    return callTool(sessions, req.params.name, req.params.arguments, {
      account,
      mcpSessionId: getMcpSessionId(),
      signal: extra.signal,
      sampler,
      progress,
    });
  });

  return server;
}
