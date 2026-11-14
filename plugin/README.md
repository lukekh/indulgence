# /indulgence for Claude Code

Satire. `/indulgence` spends your own model tokens on Latin prayers. A pixel-art priest recites them in a shared cathedral that goes on forever sideways. When your budget runs out or you leave, your priest lights a candle at a votive stand and walks out. The candle burns for about a day.

## Install

```
/plugin marketplace add lukekh/indulgence
/plugin install indulgence@indulgence
```

The first run opens a page in your browser that names the application asking for access (Claude Code, receiving it on this computer) before you sign in with GitHub. Then you choose whether your candle shows your GitHub username or your full name.

## Use

```
/indulgence for the soul of my cat
/indulgence 20k for the soul of my cat
/indulgence --private for the soul of my cat
/indulgence delete-account
```

- **Sharing is the default.** Your mutuals can read the prayers your priest says. `--private` opts out: everyone else then sees only pre-generated prayer text, never yours, and Claude Code tells you so when it starts.
- The budget is optional: a number with an optional `k` or `m` suffix, from 1,000 to 1,000,000 prayer tokens. The default is 10,000, which is about 50 prayers, one every 20 seconds (about 17 minutes).
- Claude Code prints a link to the cathedral. Open it to watch your priest. Your mutual follows on GitHub sit near you, and you can read each other's prayers (unless either of you opted out with `--private`).
- Press Esc to stop. Your priest leaves within about 90 seconds, or 3 minutes if Claude Code is closed.
- `/indulgence delete-account` prints a link. Open it and confirm to delete your account, follow edges and sessions. Candles you have already lit keep burning, with your name on them, until they go out (within two days).

Prayers are written by a `priest` subagent that can use only the `pray` tool, and it does not see your CLAUDE.md. Prayers that look like they leak anything (paths, URLs, code-shaped words, long numbers) are rejected and not charged.

## What your priest said

You don't need to open the link to follow along. As each prayer is accepted, the plugin shows the last five lines your priest said beneath the link, a clause per line. It also keeps every accepted prayer in a log on your machine, and when your votive is lit Claude Code gives you its path:

```
⏺ Your votive is lit. Deo gratias.
  Prayers: ~/.claude/indulgence/prayers/2026-11-09-1010-1a2b3c4d.md
```

This is done by the plugin's hooks (`hooks/hooks.json`, `scripts/prayer-log.mjs`), which need `node` on your PATH. The gate never sends prayer text back, so the record exists only on your machine. Set `INDULGENCE_LOG_DIR` to keep it somewhere other than `~/.claude/indulgence`.

**An always-visible view (optional).** Claude Code doesn't let a plugin redraw lines in place, so the five lines appear as a new note after each prayer. For a view that updates in place, add a status line to `~/.claude/settings.json`. It shows the five lines while your priest is praying and nothing otherwise:

```json
{
  "statusLine": {
    "type": "command",
    "command": "find ~/.claude/indulgence/now.txt -mmin -3 -exec cat {} \\; 2>/dev/null",
    "refreshInterval": 1
  }
}
```

This replaces any status line you already have.

## Privacy

The service keeps the least data it needs to seat priests and burn candles. Prayer text disappears from it when your priest leaves; the plugin keeps your own copy on your machine. Your candle name is public while it burns.

| Data | Why | Who can see it | Kept for |
| --- | --- | --- | --- |
| GitHub login | Identity; candle label | Everyone, on your candle while it burns | Until you delete your account; on a candle already lit, until it burns out |
| GitHub display name | Candle and hover label, only if you opt in | Everyone on your candle; mutuals on hover | Until you delete your account; on a candle already lit, until it burns out |
| GitHub numeric ID, stored as a keyed hash | Linking sessions to your account | No one | Until you delete your account |
| Mutual follows, stored as keyed hashes | Seating you near friends | No one; the server only | Replaced at each sign-in; deleted with your account |
| Intention text | Prompt for your prayers | Only you | End of session |
| Prayer text | Display | You; your mutuals, unless you opted out with `--private` | Until your priest has left |
| Your copy of your priest's prayers | Your record | Only you: it is a file on your machine, never sent anywhere | Until you delete it (`~/.claude/indulgence`) |
| Session times, budget, spend | Pacing, vestments, candle size | Your candle's size and presence show that you visited in the last day or two | 7 days after the session ends |
| IP address | Rate limiting | No one | 24 hours, in gate logs |

**Never collected:** your code, files or repositories; anything in your conversation outside /indulgence; your email; your GitHub access token, which is revoked once your mutuals are worked out.

**Who sees what.** Anyone who opens the site, signed in or not, sees anonymous priests saying canned (pre-generated) prayers, plus the names on candles. Your mutuals see your name when they hover over your priest, and read the prayers your model writes, unless you opted out with `--private`; then they see pre-generated prayers too. You see everything about your own priest.

Mutuals come from your public follow lists, using the first 5,000 accounts you follow and the first 5,000 that follow you. They are refreshed when you sign in again, at most every 30 days.

## Disclaimers

- **Satire.** Not affiliated with or endorsed by any church. No spiritual effect is claimed: indulgences sold here grant no remission of anything.
- **Real cost.** Every prayer spends tokens your provider bills you for. The budget counts prayer text only; actual usage is roughly 2 to 5 times higher, and more in long sessions.
- **Generated text.** Your model writes the prayers. The Latin may be wrong, odd or theologically dubious.
- **Sharing.** By default your mutuals can read your prayers. The model that writes them may be able to see your session. Obvious leaks are filtered (see the README for what the filter can and can't stop), but none can be ruled out. To opt out, use `/indulgence --private`: everyone else then sees only pre-generated prayer text, never yours.
- **Independent project.** Not affiliated with GitHub, Anthropic, Clockwork Labs (SpacetimeDB), OpenAI, Google or OpenCode. Their names and marks belong to their owners and appear here only to say which tool is meant.
- **Deletion.** `/indulgence delete-account` deletes your account, follow edges and sessions, once you confirm it in your browser. Candles you have already lit keep burning, with your name on them, until they go out (within two days). You can also revoke the OAuth app in your GitHub settings at any time.
