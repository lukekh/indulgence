// Server-rendered HTML for the sign-in flow: the page that names the application asking
// for access, the one-time consent screen, and messages. Every interpolated value is escaped.

export const DISCLAIMERS: [string, string][] = [
  ['Satire.', 'Not affiliated with or endorsed by any church. No spiritual effect is claimed: indulgences sold here grant no remission of anything.'],
  ['Real cost.', 'Every prayer spends tokens your provider bills you for. The budget counts prayer text only; actual usage is roughly 2 to 5 times higher, and more in long sessions.'],
  ['Generated text.', 'Your model writes the prayers. The Latin may be wrong, odd or theologically dubious.'],
  ['In-session tier.', 'In that mode a model that can see your session writes the prayers. Obvious leaks are filtered but none can be ruled out. Your mutuals can read your prayers unless you opt out, so if that worries you, opt out (see Sharing).'],
  ['Sharing.', 'By default the people you follow mutually on GitHub can read your prayers. To opt out, run /indulgence --private (or pass share_prayers: false to begin). Then everyone else sees only pre-generated prayer text, never yours.'],
  ['Independent project.', 'Not affiliated with GitHub, Anthropic or Clockwork Labs (SpacetimeDB).'],
  ['Deletion.', '/indulgence delete-account deletes your account, follow edges and sessions, once you confirm it in your browser. Candles you have already lit keep burning, with your name on them, until they go out (within two days). You can also revoke the OAuth app in your GitHub settings at any time.'],
];

export const CONSENT_TEXT =
  'Your GitHub username (or your full name, if you choose) will be shown publicly on your candle for about a day after each visit. ' +
  'That shows roughly when you used /indulgence. People you follow mutually on GitHub will see your name above your priest and can read your prayers, unless you opt out with /indulgence --private. ' +
  'We never see your code or your conversation. Prayers spend your own model tokens.';

export const PAGE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function shell(title: string, body: string, refreshTo?: string): string {
  const refresh = refreshTo ? `<meta http-equiv="refresh" content="6;url=${escapeHtml(refreshTo)}">` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>${refresh}
<style>
:root{color-scheme:light dark;--bg:#f4efe6;--fg:#2a2118;--muted:#6b5d4f;--accent:#7a1f1f;--card:#fffaf1;--line:#d9cbb4}
@media (prefers-color-scheme:dark){:root{--bg:#15110d;--fg:#eee3d0;--muted:#a8977f;--accent:#e0a050;--card:#1f1913;--line:#3a2f24}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 Georgia,'Iowan Old Style',serif}
main{max-width:620px;margin:0 auto;padding:40px 16px}
h1{font-size:28px;margin:0 0 4px;color:var(--accent);font-variant:small-caps;letter-spacing:.04em}
.sub{color:var(--muted);margin:0 0 24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:20px}
form{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
button{font:inherit;padding:10px 16px;border-radius:4px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--card)}
footer{margin-top:28px;font-size:13px;color:var(--muted)}
footer p{margin:6px 0}
</style></head><body><main>${body}
<footer>${DISCLAIMERS.map(([k, v]) => `<p><b>${escapeHtml(k)}</b> ${escapeHtml(v)}</p>`).join('')}</footer>
</main></body></html>`;
}

/**
 * Shown before every sign-in by an application this browser has not approved: who is
 * asking (as the application describes itself, unverified) and where the access goes.
 */
export function authorizePage(request: string, client: string, destination: string): string {
  return shell(
    '/indulgence',
    `<h1>/indulgence</h1><p class="sub">An application wants to use /indulgence as you</p>
<div class="card"><p><b>${escapeHtml(client)}</b> (as it describes itself; not verified by /indulgence) wants to act as you in the cathedral: start and end your sessions, pray in your name, and delete your account.</p>
<p>After you sign in with GitHub, it will receive that access at <b>${escapeHtml(destination)}</b>.</p>
<p>Continue only if you have just run <b>/indulgence</b> or connected the indulgence server in Claude Code yourself.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="request" value="${escapeHtml(request)}">
<button class="primary" name="decision" value="allow">Continue with GitHub</button>
<button name="decision" value="deny">Cancel</button>
</form></div>`,
  );
}

export function consentPage(pendingId: string, login: string, fullName: string): string {
  const fullButton = fullName
    ? `<button class="primary" name="choice" value="fullname">Show my full name (${escapeHtml(fullName)})</button>`
    : '';
  return shell(
    '/indulgence',
    `<h1>/indulgence</h1><p class="sub">Signed in as <b>${escapeHtml(login)}</b></p>
<div class="card"><p>${escapeHtml(CONSENT_TEXT)}</p>
<form method="post" action="/oauth/consent">
<input type="hidden" name="pending" value="${escapeHtml(pendingId)}">
<button class="primary" name="choice" value="username">Show my username (${escapeHtml(login)})</button>
${fullButton}
<button name="choice" value="cancel">Cancel</button>
</form></div>`,
  );
}

/** The page a person confirms their account's deletion on; `token` is the one-time link's. */
export function deleteAccountPage(token: string): string {
  return shell(
    'Delete your account',
    `<h1>/indulgence</h1><p class="sub">Delete your account</p>
<div class="card"><p>This deletes your /indulgence account: your name and sign-in, who you follow, and your sessions. If your priest is praying, it leaves at once without lighting a candle. It cannot be undone.</p>
<p>Candles you have already lit are not put out. They keep burning, with your name on them, until they go out by themselves (within two days).</p>
<p>If you did not ask for this, close this page and nothing happens.</p>
<form method="post" action="/delete-account">
<input type="hidden" name="t" value="${escapeHtml(token)}">
<button class="primary" name="decision" value="delete">Delete my account</button>
</form></div>`,
  );
}

export function messagePage(title: string, message: string, continueTo?: string): string {
  const link = continueTo ? `<p><a href="${escapeHtml(continueTo)}">Return to Claude Code</a></p>` : '';
  return shell(title, `<h1>${escapeHtml(title)}</h1><div class="card"><p>${escapeHtml(message)}</p>${link}</div>`, continueTo);
}
