// The welcome shown to a visitor who came without a link: what this is and how to send a
// priest in, with a tab for each agent that can do it. It sits over a bay of the cathedral
// chosen at random. The words are static; nothing from the database is put into the DOM.
//
// Every line of a command block is a button: click it and it is copied. A faint "$" at its
// left marks a command for a terminal, and a faint ">" one typed inside the agent.

/** Where a command is typed: at a shell prompt, or inside the agent's own interface. */
export type Prompt = 'shell' | 'agent';

/** One block of commands and the words that introduce it. */
export interface Step {
  /** The lead-in, in three parts; the middle one names the agent and is in its colour. */
  before: string;
  accent: string;
  after?: string;
  prompt: Prompt;
  lines: string[];
}

/** A set of instructions for one agent. */
export interface Agent {
  id: string;
  name: string;
  /** The agent's own colour, as its maker uses it on a dark ground. */
  colour: string;
  /** Connecting it to the cathedral, in order. */
  setup: Step[];
  /** What to tell it then, typed inside the agent. */
  pray: string[];
  /**
   * Another way in, folded away under `summary` after the first: its own steps, and what to
   * tell the agent then.
   */
  alternative?: { summary: string; setup: Step[]; prayLead: string; pray: string[] };
}

const OPENING = 'If you would like to convert tokens to salvation then';
const PROMPT = 'Use the indulgence tools to pray for my immortal soul: call begin, show me its url, then keep calling pray with a new Latin prayer and tier "in_session" until it says done.';

/** The agents, in tab order. `gate` is the gate's address, with no trailing slash. */
export function agents(gate: string): Agent[] {
  const mcp = `${gate}/mcp`;
  const inTerminal = (name: string, lines: string[]): Step => ({ before: `${OPENING}, `, accent: `for ${name}`, after: ', in your terminal run', prompt: 'shell', lines });
  return [
    {
      id: 'claude',
      name: 'Claude',
      colour: '#d97757', // Claude's orange
      setup: [{ before: `${OPENING} execute `, accent: 'in Claude Code', prompt: 'agent', lines: ['/plugin marketplace add lukekh/indulgence', '/plugin install indulgence@indulgence'] }],
      pray: ['/indulgence pray for my immortal soul'],
      // Without the plugin: the gate as a plain MCP server. There is no /indulgence command
      // then, so the prayer is asked for in words, as with the other agents.
      alternative: {
        summary: 'Or connect without the plugin',
        setup: [
          { before: '', accent: 'For Claude Code', after: ', in your terminal run', prompt: 'shell', lines: [`claude mcp add --transport http indulgence ${mcp}`] },
          { before: 'Then inside ', accent: 'Claude Code', after: ' sign in with', prompt: 'agent', lines: ['/mcp'] },
        ],
        prayLead: 'and pray using',
        pray: [PROMPT],
      },
    },
    {
      id: 'codex',
      name: 'Codex',
      colour: '#ffffff', // OpenAI's mark is black or white
      // The plugin (codex-plugin/): the gate as an MCP server, and a skill that knows the rite.
      setup: [inTerminal('Codex', ['codex plugin marketplace add lukekh/indulgence', 'codex plugin add indulgence@indulgence', 'codex mcp login indulgence'])],
      pray: ['Use indulgence to pray for my immortal soul'],
      alternative: {
        summary: 'Or connect without the plugin',
        setup: [{ before: '', accent: 'For Codex', after: ', in your terminal run', prompt: 'shell', lines: [`codex mcp add indulgence --url ${mcp}`, 'codex mcp login indulgence'] }],
        prayLead: 'and pray using',
        pray: [PROMPT],
      },
    },
    {
      id: 'gemini',
      name: 'Gemini',
      colour: '#4285f4', // Google blue
      // The extension (gemini-extension.json and commands/ at the repo root).
      setup: [
        inTerminal('Gemini', ['gemini extensions install https://github.com/lukekh/indulgence']),
        { before: 'Then inside ', accent: 'the Gemini CLI', after: ' run', prompt: 'agent', lines: ['/mcp auth indulgence'] },
      ],
      pray: ['/indulgence pray for my immortal soul'],
      alternative: {
        summary: 'Or connect without the extension',
        setup: [
          { before: '', accent: 'For Gemini', after: ', in your terminal run', prompt: 'shell', lines: [`gemini mcp add --transport http indulgence ${mcp}`] },
          { before: 'Then inside ', accent: 'the Gemini CLI', after: ' run', prompt: 'agent', lines: ['/mcp auth indulgence'] },
        ],
        prayLead: 'and pray using',
        pray: [PROMPT],
      },
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      colour: '#ffffff', // as is OpenCode's
      // The plugin (opencode-plugin/): it adds the gate and an /indulgence command to OpenCode's config.
      setup: [inTerminal('OpenCode', ['opencode plugin add github:lukekh/indulgence', 'opencode mcp auth indulgence'])],
      pray: ['/indulgence pray for my immortal soul'],
      alternative: {
        summary: 'Or connect without the plugin',
        setup: [{ before: '', accent: 'For OpenCode', after: ', in your terminal run', prompt: 'shell', lines: [`opencode mcp add indulgence --url ${mcp}`, 'opencode mcp auth indulgence'] }],
        prayLead: 'and pray using',
        pray: [PROMPT],
      },
    },
  ];
}

/** What stands at the left of a command: "$" at a shell, ">" inside an agent. */
export const PROMPT_MARK: Record<Prompt, string> = { shell: '$', agent: '>' };

const COPIED_MS = 1400;

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function block(doc: Document, lines: string[], prompt: Prompt, label: string): HTMLElement {
  const box = doc.createElement('div');
  box.className = 'cmd';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', label);
  for (const line of lines) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'line';
    b.title = 'Click to copy';
    // The prompt mark is not part of the command: it is neither copied nor selected.
    const mark = doc.createElement('span');
    mark.className = 'mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = PROMPT_MARK[prompt];
    const code = doc.createElement('code');
    code.textContent = line;
    const note = doc.createElement('span');
    note.className = 'note';
    note.setAttribute('aria-live', 'polite');
    b.append(mark, code, note);
    let timer = 0;
    b.addEventListener('click', () => {
      void copy(line).then((ok) => {
        // Where the clipboard is refused, select the line so Ctrl+C still takes it.
        if (!ok) doc.getSelection()?.selectAllChildren(code);
        note.textContent = ok ? 'copied' : 'select and copy';
        b.classList.toggle('done', ok);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          note.textContent = '';
          b.classList.remove('done');
        }, COPIED_MS);
      });
    });
    box.append(b);
  }
  return box;
}

export interface Landing {
  /** Show the welcome: from then on it is the page, and has nothing to close it with. */
  show(): void;
  /**
   * Step aside while something drawn on the cathedral itself is open over it (a votive
   * stand seen close up), and come back when that closes.
   */
  standAside(aside: boolean): void;
}

/**
 * Wire up the welcome panel. Until `show` is called the panel stays hidden (a visitor
 * with a link never sees it).
 */
export function setUpLanding(gate: string, doc: Document = document): Landing {
  const panel = doc.getElementById('landing');
  if (!panel) return { show: () => {}, standAside: () => {} };
  const list = agents(gate);
  const tabs = [...panel.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const setup = panel.querySelector<HTMLElement>('[data-setup]');
  const pray = panel.querySelector<HTMLElement>('[data-pray]');
  const alt = panel.querySelector<HTMLDetailsElement>('[data-alt]');
  const altBody = panel.querySelector<HTMLElement>('[data-alt-body]');

  const choose = (id: string) => {
    const agent = list.find((a) => a.id === id) ?? list[0]!;
    for (const t of tabs) {
      const on = t.dataset.agent === agent.id;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    }
    // The chosen tab and the words that name the agent are in that agent's colour.
    panel.style.setProperty('--agent', agent.colour);
    const steps = (of: Step[]) =>
      of.flatMap((step) => {
        const lead = doc.createElement('p');
        const accent = doc.createElement('span');
        accent.className = 'where';
        accent.textContent = step.accent;
        lead.append(step.before, accent, step.after ?? '');
        return [lead, block(doc, step.lines, step.prompt, `Commands for ${agent.name}`)];
      });
    setup?.replaceChildren(...steps(agent.setup));
    pray?.replaceChildren(block(doc, agent.pray, 'agent', `What to tell ${agent.name}`));
    if (alt && altBody) {
      const other = agent.alternative;
      alt.hidden = !other;
      alt.open = false;
      if (other) {
        const summary = alt.querySelector('summary');
        if (summary) summary.textContent = other.summary;
        const lead = doc.createElement('p');
        lead.textContent = other.prayLead;
        altBody.replaceChildren(...steps(other.setup), lead, block(doc, other.pray, 'agent', `What to tell ${agent.name}`));
      } else {
        altBody.replaceChildren();
      }
    }
  };
  tabs.forEach((t, i) => {
    const own = list.find((a) => a.id === t.dataset.agent);
    if (own) t.style.setProperty('--tab', own.colour);
    t.addEventListener('click', () => choose(t.dataset.agent!));
    // Left and right move between the tabs, as in any tab list.
    t.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      const next = tabs[(i + step + tabs.length) % tabs.length]!;
      next.focus();
      choose(next.dataset.agent!);
    });
  });
  choose(list[0]!.id);

  let shown = false;
  let aside = false;
  const apply = () => {
    panel.hidden = !shown || aside;
  };
  return {
    show: () => {
      shown = true;
      apply();
    },
    standAside: (on) => {
      if (on === aside) return;
      aside = on;
      apply();
    },
  };
}
