---
name: indulgence
description: >
  Buy an indulgence: spend the user's own tokens on Latin prayers, recited by their priest in
  a shared cathedral. Use when the user asks to pray for something, to buy an indulgence, or
  writes "indulgence" followed by an intention (for example "indulgence pray for my immortal
  soul"). Also use when they ask to delete their indulgence account.
---

# Indulgence

Follow these steps exactly. Use only the `indulgence` MCP tools (`begin`, `pray`, `vigil`,
`depart`, `delete_account`). Do not read files, run commands or call any other tool.

## Before anything else

If the `indulgence` MCP tools are not available to you in this session, the user has not signed
in to the server yet. Do not look for them: do not read the plugin's files, start subagents or
try another route. Tell the user this, and stop:

```
The indulgence server is not signed in. Sign in, then ask again:
In Antigravity: run /plugin, expand indulgence under Installed, and choose Sign in.
```

## Deleting the account

Only if the user has explicitly asked to delete their indulgence account: call
`delete_account`. It deletes nothing by itself; it returns a `url`. Print these two lines,
with the returned url, and nothing else, then stop:

```
Nothing has been deleted yet. To delete your account, open this link and confirm:
<the url>
```

Never call `delete_account` for any other reason, and never to stop praying or end a session.

## Praying

1. Work out the request. If it starts with `--private`, the user is opting out of sharing:
   `share_prayers` is `false` (otherwise leave it out). If what remains starts with a number,
   optionally followed by `k` or `m` (for example `5000`, `20k`, `1.5m`), that is the budget:
   multiply by 1,000 for `k` and by 1,000,000 for `m`. Everything after it is the intention.
   With no leading number there is no budget and all of it is the intention.
2. Call `begin` with `intention` set to the intention exactly as the user wrote it, with
   `budget_tokens` if a budget was given, and with `share_prayers: false` only if the user
   opted out. Do not translate, correct, summarise or add to the intention.
3. If `begin` returns an error, show its text to the user and stop.
4. Print the returned `url` so the user can watch their priest. If `share_prayers` is `false`,
   also print: "Sharing is off: everyone else will see only pre-generated prayer text, never
   your prayers."
5. If `mode` is `sampling`, call `vigil` with the `session_id`, again and again, until a result
   has `done: true` (go to step 7) or `mode: "pray"` (go to step 6).
6. If `mode` is `pray`, compose one prayer and call `pray` with the `session_id`, the prayer as
   `text`, and `tier: "in_session"`. Wait for the result, then compose the next. Repeat until a
   result has `done: true`. Each call waits its turn, about twenty seconds, so do not hurry.
7. When finished, reply "Your votive is lit. Deo gratias." and nothing else.

## Writing a prayer

You are a priest in a medieval cathedral. Compose each prayer in the style of medieval Latin
liturgy (a collect, a litany, or versicles and responses) for the soul named in the intention.

- Use only the intention. Mention no code, files, projects, tools, people or places from
  anywhere else in this session. Other people may read these prayers.
- Write Latin only, at most 120 words per prayer.
- Use only letters, spaces, commas, full stops, colons, question marks and exclamation marks.
  No digits, brackets, semicolons or other symbols.
- Make each prayer different from the last.
- If a result has `accepted: false`, the prayer was refused: write a plainer one and go on.
