import { describe, expect, it } from 'vitest';
import { agents, PROMPT_MARK } from '../src/landing';

describe('the welcome', () => {
  const list = agents('https://gate.test');
  const lines = (a: (typeof list)[number]) => [...a.setup, ...(a.alternative?.setup ?? [])].flatMap((s) => s.lines).concat(a.pray, a.alternative?.pray ?? []);

  it('has a tab for each agent, in alphabetical order, Claude first', () => {
    expect(list.map((a) => a.name)).toEqual(['Claude', 'Codex', 'Gemini', 'OpenCode']);
    expect(list.map((a) => a.id)).toEqual(['claude', 'codex', 'gemini', 'opencode']);
    expect(new Set(list.map((a) => a.name)).size).toBe(list.length);
  });

  it('installs the plugin in Claude Code and prays with the command, all typed inside it', () => {
    const claude = list[0]!;
    expect(claude.setup).toHaveLength(1);
    expect(claude.setup[0]!.lines).toEqual(['/plugin marketplace add lukekh/indulgence', '/plugin install indulgence@indulgence']);
    expect(claude.setup[0]!.prompt).toBe('agent');
    expect(claude.pray).toEqual(['/indulgence pray for my immortal soul']);
  });

  it('offers Claude Code a way in without the plugin: the gate as an MCP server, then a prayer in words', () => {
    const other = list[0]!.alternative!;
    expect(other.setup.map((s) => [s.prompt, s.lines])).toEqual([
      ['shell', ['claude mcp add --transport http indulgence https://gate.test/mcp']],
      ['agent', ['/mcp']],
    ]);
    expect(other.pray.join(' ')).toContain('pray for my immortal soul');
    expect(other.pray.join(' ')).not.toContain('/indulgence'); // there is no such command without the plugin
    for (const a of list.slice(1)) expect(a.alternative).toBeUndefined();
  });

  it("points every other agent at this gate's MCP endpoint, from the terminal", () => {
    for (const a of list.slice(1)) {
      expect(a.setup[0]!.prompt).toBe('shell');
      expect(a.setup[0]!.lines[0]).toContain('https://gate.test/mcp');
      expect(a.setup[0]!.lines[0]).toContain('indulgence');
      expect(a.pray.join(' ')).toContain('pray for my immortal soul');
    }
  });

  it('splits Gemini in two: one command in the terminal, then one inside the Gemini CLI', () => {
    const gemini = list.find((a) => a.id === 'gemini')!;
    expect(gemini.setup.map((s) => [s.prompt, s.lines])).toEqual([
      ['shell', ['gemini mcp add --transport http indulgence https://gate.test/mcp']],
      ['agent', ['/mcp auth indulgence']],
    ]);
    expect(gemini.setup[0]!.after).toBe(', in your terminal run');
    const second = gemini.setup[1]!;
    expect(second.before + second.accent + second.after).toBe('Then inside the Gemini CLI run');
  });

  it('marks a terminal command with $ and one typed inside an agent with >, and a slash command is never a terminal one', () => {
    expect(PROMPT_MARK).toEqual({ shell: '$', agent: '>' });
    for (const a of list) {
      for (const s of [...a.setup, ...(a.alternative?.setup ?? [])]) for (const l of s.lines) expect(l.startsWith('/')).toBe(s.prompt === 'agent');
    }
  });

  it('gives each agent its own colour, and names it in the words that take that colour', () => {
    expect(Object.fromEntries(list.map((a) => [a.id, a.colour]))).toEqual({ claude: '#d97757', codex: '#ffffff', opencode: '#ffffff', gemini: '#4285f4' });
    for (const a of list) expect(a.setup[0]!.accent).toContain(a.name);
  });

  it('gives commands one to a line, with nothing to trim and no prompt mark in them', () => {
    for (const a of list) {
      for (const line of lines(a)) {
        expect(line).toBe(line.trim());
        expect(line).not.toContain('\n');
        expect(line).not.toMatch(/^[$>]/);
      }
    }
  });
});
