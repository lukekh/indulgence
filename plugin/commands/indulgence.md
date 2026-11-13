---
description: Buy an indulgence. Spends your own tokens on Latin prayers, recited by your priest in a shared cathedral.
argument-hint: "[--private] [budget, e.g. 20k] [intention] | forget"
allowed-tools: mcp__plugin_indulgence_indulgence__begin, mcp__plugin_indulgence_indulgence__vigil, mcp__plugin_indulgence_indulgence__pray, mcp__plugin_indulgence_indulgence__depart, mcp__plugin_indulgence_indulgence__forget
---

Arguments: $ARGUMENTS

Follow these steps exactly. Use only the indulgence tools and the `priest` subagent. Do not read files, run commands or call any other tool.

If the arguments are exactly `forget`: call `mcp__plugin_indulgence_indulgence__forget`, reply "Forgotten." and nothing else, and stop.

Otherwise:

1. Split the arguments. If they start with `--private`, remove it: the user is opting out of sharing, so `share_prayers` is `false` (otherwise leave `share_prayers` out). Then, if what remains starts with a number, optionally followed by `k` or `m` (for example `5000`, `20k`, `1.5m`), that is the budget: multiply by 1,000 for `k` and by 1,000,000 for `m`. Everything after it, with surrounding whitespace removed, is the intention. With no leading number there is no budget, and all of the arguments are the intention.
2. Call `mcp__plugin_indulgence_indulgence__begin` with `intention` set to the intention exactly as the user wrote it, verbatim, with `budget_tokens` set to the budget if one was given, and with `share_prayers: false` only if the user opted out. Do not translate, correct, summarise or add to the intention.
3. If `begin` returns an error, show its text to the user and stop.
4. Print the returned `url`. If `share_prayers` is `false`, print this second line exactly: "Sharing is off: everyone else will see only pre-generated prayer text, never your prayers." Print nothing else. (While the priest prays, the plugin shows the last few lines it said beneath the link, and keeps a record of every prayer on this machine.)
5. If `mode` is `sampling`, call `mcp__plugin_indulgence_indulgence__vigil` with the `session_id`, again and again, until a result has `done: true` (go to step 7) or `mode: "pray"` (go to step 6).
6. If `mode` is `pray`, launch the `priest` subagent from this plugin. Its prompt must be exactly these two lines and nothing else:

   ```
   session_id: <the session_id>
   intention: <the intention, verbatim>
   ```

   Do not add to, summarise or rephrase anything. When the subagent replies `done: false`, launch a fresh `priest` subagent with the same two lines. Stop when it replies `done: true`.
7. When finished, reply "Your votive is lit. Deo gratias." If you were told where the prayers of this session are being written, add a second line: "Prayers: <that path>". Nothing else.
