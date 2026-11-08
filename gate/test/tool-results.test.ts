// Acceptance: no tool result contains any user-written text (property test over all tools).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callTool, TOOLS, ERROR_TEXT } from '../src/mcp.js';
import { SessionManager, type Sampler } from '../src/sessions.js';
import { FakeStore, LATIN_PRAYERS } from './fakes.js';

const alice = { ghHash: 'a'.repeat(32), viewerSub: 'v.alice' };

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:;!?/@{}[]()<>="\'`_-​‮éæ漢';

function randomString(r: () => number, marker: string): string {
  const len = Math.floor(r() * 40);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(r() * ALPHABET.length)];
  const at = Math.floor(r() * (s.length + 1));
  return s.slice(0, at) + marker + s.slice(at);
}

function randomValue(r: () => number, marker: string): unknown {
  const k = r();
  if (k < 0.55) return randomString(r, marker);
  if (k < 0.65) return Math.floor(r() * 2e6) - 1e5;
  if (k < 0.7) return null;
  if (k < 0.75) return [randomString(r, marker)];
  if (k < 0.8) return { nested: randomString(r, marker) };
  if (k < 0.85) return true;
  // A Latin prayer carrying the marker as a "word", so it can pass the Latin check.
  return `${LATIN_PRAYERS[Math.floor(r() * 4)]} ${marker}`;
}

function resultText(res: unknown): string {
  return JSON.stringify(res);
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
afterEach(() => vi.useRealTimers());

async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  let v!: T;
  void p.then((x) => {
    done = true;
    v = x;
  });
  for (let i = 0; i < 2000 && !done; i++) await vi.advanceTimersByTimeAsync(500);
  if (!done) throw new Error('did not settle');
  return v;
}

describe('tool results', () => {
  it('never contain user-written text, for any tool and any arguments', async () => {
    const r = rng(20261108);
    let calls = 0;
    let acceptedMarked = 0;
    for (let trial = 0; trial < 150; trial++) {
      const store = new FakeStore();
      store.accounts.set(alice.ghHash, { ...alice, ghLogin: 'alice', ghName: 'Alice Secret', mutualHashes: [], labelMode: 'FullName' });
      const sessions = new SessionManager(store, 'https://site.test');
      // Intentions, prayers and names are all user-written; mark each one.
      const marker = `Zq${trial}x${Math.floor(r() * 1e9).toString(36)}`;
      const sampled = `${LATIN_PRAYERS[trial % 4]} ${marker}`;
      const sampler: Sampler | undefined = trial % 3 === 0 ? async () => sampled : undefined;

      // A real session to aim at, begun with a marked intention.
      const begun = await callTool(sessions, 'begin', { intention: `for ${marker}`, budget_tokens: 1000 }, { account: alice, signal: new AbortController().signal, sampler });
      calls++;
      expect(resultText(begun)).not.toContain(marker);
      expect(resultText(begun)).not.toContain('Alice Secret');
      const sessionId = (begun.structuredContent as { session_id?: string } | undefined)?.session_id;

      for (let k = 0; k < 6; k++) {
        const tool = TOOLS[Math.floor(r() * TOOLS.length)]!.name;
        const name = r() < 0.05 ? randomString(r, marker) : tool;
        const args: Record<string, unknown> = {};
        for (const key of ['intention', 'budget_tokens', 'text', 'tier', 'session_id', marker]) {
          if (r() < 0.6) args[key] = randomValue(r, marker);
        }
        if (sessionId && r() < 0.6) args.session_id = sessionId;
        if (r() < 0.5) args.tier = r() < 0.5 ? 'subagent' : 'in_session';
        const rawArgs = r() < 0.05 ? randomValue(r, marker) : args;
        const ac = new AbortController();
        if (r() < 0.1) setTimeout(() => ac.abort(), 1000);
        const res = await settle(callTool(sessions, name, rawArgs, { account: r() < 0.95 ? alice : undefined, signal: ac.signal, sampler }));
        calls++;
        const text = resultText(res);
        expect(text, `${name} ${JSON.stringify(rawArgs)}`).not.toContain(marker);
        expect(text).not.toContain('Alice Secret');
        // Errors are drawn from a fixed set; successes are JSON with known keys only.
        if (res.isError) {
          expect(Object.values(ERROR_TEXT)).toContain((res.content[0] as { text: string }).text);
        } else {
          const keys = Object.keys(res.structuredContent ?? {});
          expect(keys.every((k) => ['session_id', 'url', 'mode', 'budget_tokens', 'done', 'accepted', 'left', 'prayers', 'spent', 'ok'].includes(k))).toBe(true);
          for (const v of Object.values(res.structuredContent ?? {})) {
            expect(['number', 'boolean', 'string'].includes(typeof v)).toBe(true);
            if (typeof v === 'string') expect(v).toMatch(/^(sampling|pray|https:\/\/site\.test\/#t=[\w-]+|[\w-]{24})$/);
          }
        }
      }
      for (const s of store.sessions.values()) acceptedMarked += s.prayers.filter((p) => p.text.includes(marker)).length;
    }
    expect(calls).toBeGreaterThan(800);
    // Marked prayers really were accepted and stored, so the property is not vacuous.
    expect(acceptedMarked).toBeGreaterThan(20);
  }, 120_000);
});
