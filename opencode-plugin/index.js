// The OpenCode plugin for /indulgence.
//
// OpenCode plugins are code, not manifests, so this one works by adding to OpenCode's config as
// it loads: the gate as a remote MCP server (OpenCode finds its OAuth sign-in by itself) and
// an /indulgence command carrying the rite. It is the same protocol as the Claude Code
// plugin's command (plugin/commands/indulgence.md), the Codex plugin's skill and the Gemini
// CLI extension's command. Anything you have already set under the same names wins.
//
//   opencode plugin add github:lukekh/indulgence     (before OpenCode 1.19: without "add")
//   opencode mcp auth indulgence
//
// Options (in the "plugin" entry of opencode.json): { "gateUrl": "http://localhost:8787" }.

export const GATE_URL = 'https://indulgence-gate.fly.dev';

export const DESCRIPTION = 'Buy an indulgence. Spends your own tokens on Latin prayers, recited by your priest in a shared cathedral.';

export const RITE = `Arguments: $ARGUMENTS

Follow these steps exactly. Use only the indulgence MCP tools (begin, pray, vigil, depart, delete_account). Do not read files, run commands or call any other tool.

If the arguments are exactly \`delete-account\`: call delete_account. It deletes nothing by itself; it returns a \`url\`. Print these two lines, with the returned url, and nothing else, then stop:

Nothing has been deleted yet. To delete your account, open this link and confirm:
<the url>

Never call delete_account for any other arguments, and never to stop praying or end a session.

Otherwise:

1. Split the arguments. If they start with \`--private\`, remove it: the user is opting out of sharing, so \`share_prayers\` is \`false\` (otherwise leave \`share_prayers\` out). Then, if what remains starts with a number, optionally followed by \`k\` or \`m\` (for example \`5000\`, \`20k\`, \`1.5m\`), that is the budget: multiply by 1,000 for \`k\` and by 1,000,000 for \`m\`. Everything after it, with surrounding whitespace removed, is the intention. With no leading number there is no budget, and all of the arguments are the intention.
2. Call begin with \`intention\` set to the intention exactly as the user wrote it, with \`budget_tokens\` set to the budget if one was given, and with \`share_prayers: false\` only if the user opted out. Do not translate, correct, summarise or add to the intention.
3. If begin returns an error, show its text to the user and stop.
4. Print the returned \`url\` so the user can watch their priest. If \`share_prayers\` is \`false\`, also print: "Sharing is off: everyone else will see only pre-generated prayer text, never your prayers."
5. If \`mode\` is \`sampling\`, call vigil with the \`session_id\`, again and again, until a result has \`done: true\` (go to step 7) or \`mode: "pray"\` (go to step 6).
6. If \`mode\` is \`pray\`, compose one prayer and call pray with the \`session_id\`, the prayer as \`text\`, and \`tier: "in_session"\`. Wait for the result, then compose the next. Repeat until a result has \`done: true\`. Each call waits its turn, about twenty seconds, so do not hurry.
7. When finished, reply "Your votive is lit. Deo gratias." and nothing else.

Writing a prayer: you are a priest in a medieval cathedral. Compose each prayer in the style of medieval Latin liturgy (a collect, a litany, or versicles and responses) for the soul named in the intention.

- Use only the intention. Mention no code, files, projects, tools, people or places from anywhere else in this session. Other people may read these prayers.
- Write Latin only, at most 120 words per prayer.
- Use only letters, spaces, commas, full stops, colons, question marks and exclamation marks. No digits, brackets, semicolons or other symbols.
- Make each prayer different from the last.
- If a result has \`accepted: false\`, the prayer was refused: write a plainer one and go on.
`;

/** Add the gate and the command to a config, leaving alone anything already set under those names. */
export function configure(config, options = {}) {
  const gate = typeof options.gateUrl === 'string' && options.gateUrl ? options.gateUrl.replace(/\/+$/, '') : GATE_URL;
  config.mcp ??= {};
  config.mcp.indulgence ??= { type: 'remote', url: `${gate}/mcp`, enabled: true };
  config.command ??= {};
  config.command.indulgence ??= { description: DESCRIPTION, template: RITE };
  return config;
}

/** @type {import('@opencode-ai/plugin').Plugin} */
export const IndulgencePlugin = async (_input, options) => ({
  config: async (config) => {
    configure(config, options ?? {});
  },
});

export default { id: 'indulgence', server: IndulgencePlugin };
