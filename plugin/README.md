# /indulgence for Claude Code

Satire. `/indulgence` spends your own model tokens on Latin prayers. A pixel-art priest recites them in a shared cathedral that goes on forever sideways. When your budget runs out or you leave, your priest lights a candle at a votive stand and walks out. The candle burns for about a day.

## Install

```
/plugin marketplace add lukekh/indulgence
/plugin install indulgence@indulgence
```

The first run opens a page in your browser that names the application asking for access (Claude Code, receiving it on this computer) before you sign in: with GitHub, or with Google, Microsoft, Discord or LinkedIn where the gate offers them. Then you choose whether your candle shows your username (or first name) or your full name.

## Use

```
/indulgence for the soul of my cat
/indulgence 20k for the soul of my cat
/indulgence --private for the soul of my cat
/indulgence delete-account
```

- **Sharing is the default.** Your mutuals, and the public livestream, can read the prayers your priest says (with LinkedIn, everyone can). `--private` opts out: everyone else then sees only pre-generated prayer text, never yours, and Claude Code tells you so when it starts. Your name is still shown.
- The budget is optional: a number with an optional `k` or `m` suffix, from 1,000 to 1,000,000 prayer tokens. The default is 10,000, which is about 50 prayers, one every 20 seconds (about 17 minutes).
- Claude Code prints a link to the cathedral. Open it to watch your priest. Your mutuals sit near you, and you can read each other's prayers (unless either of you opted out with `--private`). Who your mutuals are depends on how you signed in: see the [README](../README.md#where-you-sit-near-people-you-know).
- Press Esc to stop. Your priest leaves within about 90 seconds, or 3 minutes if Claude Code is closed.
- `/indulgence delete-account` prints a link. Open it and confirm to delete your account, follow edges, networks and sessions. Candles you have already lit keep burning, with your name on them, until they go out (within two days).

Prayers are written by a `priest` subagent that can use only the `pray` tool, and it does not see your CLAUDE.md. Prayers that look like they leak anything (paths, URLs, code-shaped words, long numbers) are rejected and not charged.

## What your priest said

You don't need to open the link to follow along. As each prayer is accepted, the plugin shows the last five lines your priest said beneath the link, a clause per line. It also keeps every accepted prayer in a log on your machine, and when your votive is lit Claude Code gives you its path:

```
⏺ Your votive is lit. Deo gratias.
  Prayers: ~/.indulgence/prayers/2026-11-09-1010-1a2b3c4d.md
```

This is done by the plugin's hooks (`hooks/hooks.json`, `scripts/prayer-log.mjs`), which need `node` on your PATH. The gate never sends prayer text back, so the record exists only on your machine. The Codex, Antigravity and OpenCode plugins keep theirs in the same folder, with the same script. Set `INDULGENCE_LOG_DIR` to keep it somewhere other than `~/.indulgence`.

**An always-visible view (optional).** Claude Code doesn't let a plugin redraw lines in place, so the five lines appear as a new note after each prayer. For a view that updates in place, add a status line to `~/.claude/settings.json`. It shows the five lines while your priest is praying and nothing otherwise:

```json
{
  "statusLine": {
    "type": "command",
    "command": "find ~/.indulgence/now.txt -mmin -3 -exec cat {} \\; 2>/dev/null",
    "refreshInterval": 1
  }
}
```

This replaces any status line you already have.

## Privacy

The service keeps the least data it needs to seat priests and burn candles. Prayer text disappears from it when your priest leaves; the plugin keeps your own copy on your machine. Your candle name is public while it burns.

| Data | Why | Who can see it | Kept for |
| --- | --- | --- | --- |
| Username (GitHub, Discord) or first name (Google, Microsoft, LinkedIn) | Identity; candle label | Everyone, on your candle while it burns; the livestream, while you pray | Until you delete your account; on a candle already lit, until it burns out |
| Full name | Candle and hover label, only if you opt in | Everyone on your candle; mutuals on hover; the livestream | Until you delete your account; on a candle already lit, until it burns out |
| Your ID where you signed in, stored as a keyed hash | Linking sessions to your account | No one | Until you delete your account |
| Mutual follows (GitHub), stored as keyed hashes | Seating you near friends | No one; the server only | Replaced at each sign-in; deleted with your account |
| Networks: your Google Workspace, Microsoft organisation or small Discord servers, stored as keyed hashes | Seating you near colleagues and friends | No one; the server only, which cannot tell which they are | Replaced at each sign-in; deleted with your account |
| Intention text | Prompt for your prayers | Only you | End of session |
| Prayer text | Display | You; your mutuals and the livestream (everyone, with LinkedIn), unless you opted out with `--private` | Until your priest has left |
| Your copy of your priest's prayers | Your record | Only you: it is a file on your machine, never sent anywhere | Until you delete it (`~/.indulgence`) |
| Session times, budget, spend | Pacing, vestments, candle size | Your candle's size and presence show that you visited in the last day or two | 7 days after the session ends |
| IP address | Rate limiting | No one | 24 hours, in gate logs |

**Never collected:** your code, files or repositories; anything in your conversation outside /indulgence; your email; the names of your Workspace, organisation or servers; any access token for the account you signed in with (GitHub's and Discord's are revoked once your network is worked out; Google, Microsoft and LinkedIn's are never used).

**Who sees what.** Anyone who opens the site, signed in or not, sees anonymous priests saying canned (pre-generated) prayers, plus the names on candles, and the names and prayers of people who signed in with LinkedIn. Your mutuals see your name when they hover over your priest, and read the prayers your model writes, unless you opted out with `--private`; then they see pre-generated prayers too. The public livestream shows everyone's name, and the prayers of everyone who shares them. If you sign in with Google or Microsoft, your organisation's administrators can see that you did. You see everything about your own priest.

With GitHub, mutuals come from your public follow lists, using the first 5,000 accounts you follow and the first 5,000 that follow you. With Google, Microsoft or Discord, they are the people who share your Workspace, organisation or a server of up to 200 members. They are refreshed when you sign in again, at most every 30 days.

## Disclaimers

- **Satire.** Not affiliated with or endorsed by any church. No spiritual effect is claimed: indulgences sold here grant no remission of anything.
- **Real cost.** Every prayer spends tokens your provider bills you for. The budget counts prayer text only; actual usage is roughly 2 to 5 times higher, and more in long sessions.
- **Generated text.** Your model writes the prayers. The Latin may be wrong, odd or theologically dubious.
- **Sharing.** By default your mutuals and the public livestream can read your prayers (with LinkedIn, everyone can). The model that writes them may be able to see your session. Obvious leaks are filtered (see the README for what the filter can and can't stop), but none can be ruled out. To opt out, use `/indulgence --private`: everyone else then sees only pre-generated prayer text, never yours.
- **Independent project.** Not affiliated with GitHub, Google, Microsoft, Discord, LinkedIn, Anthropic, Clockwork Labs (SpacetimeDB), OpenAI or OpenCode. Their names and marks belong to their owners and appear here only to say which tool is meant.
- **Deletion.** `/indulgence delete-account` deletes your account, follow edges, networks and sessions, once you confirm it in your browser. Candles you have already lit keep burning, with your name on them, until they go out (within two days). You can also remove /indulgence from the connected apps of the account you signed in with, at any time.
