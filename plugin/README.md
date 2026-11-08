# /indulgence for Claude Code

Satire. `/indulgence` spends your own model tokens on Latin prayers. A pixel-art priest recites them in a shared cathedral that goes on forever sideways. When your budget runs out or you leave, your priest lights a candle at a votive stand and walks out. The candle burns for about a day.

## Install

```
/plugin marketplace add lukekh/indulgence
/plugin install indulgence@indulgence
```

The first run opens GitHub sign-in in your browser. Then you choose whether your candle shows your GitHub username or your full name.

## Use

```
/indulgence for the soul of my cat
/indulgence 20k for the soul of my cat
/indulgence forget
```

- The budget is optional: a number with an optional `k` or `m` suffix, from 1,000 to 1,000,000 prayer tokens. The default is 10,000, which is about 50 prayers, one every 20 seconds (about 17 minutes).
- Claude Code prints a link to the cathedral. Open it to watch your priest. Your mutual follows on GitHub sit near you, and you can read each other's prayers.
- Press Esc to stop. Your priest leaves within about 90 seconds, or 3 minutes if Claude Code is closed.
- `/indulgence forget` deletes your account, follow edges, sessions and candles.

Prayers are written by a `priest` subagent that can use only the `pray` tool, and it does not see your CLAUDE.md. Prayers that look like they leak anything (paths, URLs, code-shaped words, long numbers) are rejected and not charged.

## Privacy

The service keeps the least data it needs to seat priests and burn candles. Prayer text disappears when your priest leaves. Your candle name is public while it burns.

| Data | Why | Who can see it | Kept for |
| --- | --- | --- | --- |
| GitHub login | Identity; candle label | Everyone, on your candle while it burns | Until you run `forget` |
| GitHub display name | Candle and hover label, only if you opt in | Everyone on your candle; mutuals on hover | Until you run `forget` |
| GitHub numeric ID, stored as a keyed hash | Linking sessions to your account | No one | Until `forget` |
| Mutual follows, stored as keyed hashes | Seating you near friends | No one; the server only | Replaced at each sign-in; deleted by `forget` |
| Intention text | Prompt for your prayers | Only you | End of session |
| Prayer text | Display | You; your mutuals if made by the sampling or subagent tier | Until your priest has left |
| Session times, budget, spend | Pacing, vestments, candle size | Your candle's size and presence show that you visited in the last day or two | 7 days after the session ends |
| IP address | Rate limiting | No one | 24 hours, in gate logs |

**Never collected:** your code, files or repositories; anything in your conversation outside /indulgence; your email; your GitHub access token, which is revoked once your mutuals are worked out.

**Who sees what.** Strangers see an anonymous priest saying canned prayers, plus the names on candles. Your mutuals see your name when they hover over your priest, and read your generated prayers (not in-session ones). You see everything about your own priest.

Mutuals come from your public follow lists, using the first 5,000 accounts you follow and the first 5,000 that follow you. They are refreshed when you sign in again, at most every 30 days.

## Disclaimers

- **Satire.** Not affiliated with or endorsed by any church. No spiritual effect is claimed: indulgences sold here grant no remission of anything.
- **Real cost.** Every prayer spends tokens your provider bills you for. The budget counts prayer text only; actual usage is roughly 2 to 5 times higher, and more in long sessions.
- **Generated text.** Your model writes the prayers. The Latin may be wrong, odd or theologically dubious.
- **In-session tier.** In that mode a model that can see your session writes the prayers. Obvious leaks are filtered but none can be ruled out, which is why those prayers are shown only to you.
- **Independent project.** Not affiliated with GitHub, Anthropic or Clockwork Labs (SpacetimeDB).
- **Deletion.** `/indulgence forget` deletes your account, follow edges, sessions and candles. You can also revoke the OAuth app in your GitHub settings at any time.
