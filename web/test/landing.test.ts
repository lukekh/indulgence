import { describe, expect, it } from 'vitest';
import { agents, PROMPT_MARK } from '../src/landing';

describe('the welcome', () => {
  const list = agents('https://gate.test');
  const lines = (a: (typeof list)[number]) => [...a.setup, ...(a.alternative?.setup ?? [])].flatMap((s) => s.lines).concat(a.pray, a.alternative?.pray ?? []);

  it('has a tab for each agent, in alphabetical order', () => {
    expect(list.map((a) => a.name)).toEqual(['Antigravity', 'Claude', 'Codex', 'OpenCode']);
    expect(list.map((a) => a.id)).toEqual(['antigravity', 'claude', 'codex', 'opencode']);
    expect(new Set(list.map((a) => a.name)).size).toBe(list.length);
  });

  it('installs the plugin in Claude Code and prays with the command, all typed inside it', () => {
    const claude = list.find((a) => a.id === 'claude')!;
    expect(claude.setup).toHaveLength(1);
    expect(claude.setup[0]!.lines).toEqual(['/plugin marketplace add lukekh/indulgence', '/plugin install indulgence@indulgence']);
    expect(claude.setup[0]!.prompt).toBe('agent');
    expect(claude.pray).toEqual(['/indulgence pray for my immortal soul']);
  });

  it('offers Claude Code a way in without the plugin: the gate as an MCP server, then a prayer in words', () => {
    const other = list.find((a) => a.id === 'claude')!.alternative!;
    expect(other.setup.map((s) => [s.prompt, s.lines])).toEqual([
      ['shell', ['claude mcp add --transport http indulgence https://gate.test/mcp']],
      ['agent', ['/mcp']],
    ]);
    expect(other.pray.join(' ')).toContain('pray for my immortal soul');
    expect(other.pray.join(' ')).not.toContain('/indulgence'); // there is no such command without the plugin
  });

  it('installs the Codex plugin from this repo, with plain MCP as the other way', () => {
    const codex = list.find((a) => a.id === 'codex')!;
    expect(codex.setup).toHaveLength(1);
    expect(codex.setup[0]!.prompt).toBe('shell');
    expect(codex.setup[0]!.lines).toEqual(['codex plugin marketplace add lukekh/indulgence', 'codex plugin add indulgence@indulgence', 'codex mcp login indulgence']);
    expect(codex.alternative!.setup[0]!.lines[0]).toBe('codex mcp add indulgence --url https://gate.test/mcp');
  });

  it('installs the Antigravity plugin from a clone of this repo, signs in inside the Antigravity CLI, and prays in words', () => {
    const anti = list.find((a) => a.id === 'antigravity')!;
    expect(anti.setup.map((s) => [s.prompt, s.lines])).toEqual([
      ['shell', ['git clone https://github.com/lukekh/indulgence', 'agy plugin install indulgence/antigravity-plugin']],
      ['agent', ['/plugin']],
    ]);
    const second = anti.setup[1]!;
    expect(second.before + second.accent + second.after).toBe('Then inside the Antigravity CLI open the plugin and choose Sign in');
    expect(anti.pray).toEqual(['Use indulgence to pray for my immortal soul']);
    expect(anti.alternative!.setup[0]!.lines).toEqual(['agy mcp add indulgence https://gate.test/mcp']);
  });

  it('installs the OpenCode plugin from this repo and prays with its command, with plain MCP as the other way', () => {
    const opencode = list.find((a) => a.id === 'opencode')!;
    expect(opencode.setup.map((s) => [s.prompt, s.lines])).toEqual([['shell', ['opencode plugin add github:lukekh/indulgence', 'opencode mcp auth indulgence']]]);
    expect(opencode.pray).toEqual(['/indulgence pray for my immortal soul']);
    expect(opencode.alternative!.setup[0]!.lines[0]).toBe('opencode mcp add indulgence --url https://gate.test/mcp');
  });

  it("gives every agent another way in, through this gate's MCP endpoint and a prayer in words", () => {
    for (const a of list) {
      const other = a.alternative!;
      expect(other.summary).toBe('Or connect without the plugin');
      expect(other.setup[0]!.lines[0]).toContain('https://gate.test/mcp');
      expect(other.pray.join(' ')).toContain('pray for my immortal soul');
      expect(other.pray.join(' ')).not.toContain('/indulgence');
    }
  });

  it('marks a terminal command with $ and one typed inside an agent with >, and a slash command is never a terminal one', () => {
    expect(PROMPT_MARK).toEqual({ shell: '$', agent: '>' });
    for (const a of list) {
      for (const s of [...a.setup, ...(a.alternative?.setup ?? [])]) for (const l of s.lines) expect(l.startsWith('/')).toBe(s.prompt === 'agent');
    }
  });

  it('gives each agent its own colour, and names it in the words that take that colour', () => {
    expect(Object.fromEntries(list.map((a) => [a.id, a.colour]))).toEqual({ antigravity: '#3186ff', claude: '#d97757', codex: '#ffffff', opencode: '#ffffff' });
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
