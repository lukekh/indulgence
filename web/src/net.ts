// Viewer access: trade the one-time ticket from the URL fragment for a view-only JWT, keep
// it in sessionStorage only, and refresh it while the priest is live.

export const GATE_URL: string = (import.meta.env.VITE_GATE_URL as string | undefined)?.replace(/\/+$/, '') ?? 'http://localhost:8787';

export interface ViewerGrant {
  token: string;
  uri: string;
  module: string;
  px: number;
  priest_id: string;
  server_time: number;
  expires_at: number;
  /** Local clock when the grant arrived; with server_time gives the clock skew. */
  received_at: number;
}

const KEY = 'indulgence.viewer';

export function takeTicketFromUrl(): string | undefined {
  const m = /[#&]t=([A-Za-z0-9_-]{16,64})/.exec(location.hash);
  if (!m) return undefined;
  // Drop the ticket from the address bar and history; it is single use anyway.
  history.replaceState(null, '', location.pathname + location.search);
  return m[1];
}

export function loadGrant(): ViewerGrant | undefined {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return undefined;
    const g = JSON.parse(raw) as ViewerGrant;
    return g.expires_at > Date.now() + 60_000 ? g : undefined;
  } catch {
    return undefined;
  }
}

export function saveGrant(g: ViewerGrant) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(g));
  } catch {
    // Private mode or storage blocked: the page still works until reload.
  }
}

export function clearGrant() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

async function post(path: string, init: RequestInit): Promise<ViewerGrant | undefined> {
  const sent = Date.now();
  const res = await fetch(`${GATE_URL}${path}`, { method: 'POST', ...init });
  if (!res.ok) return undefined;
  const body = (await res.json()) as Omit<ViewerGrant, 'received_at'>;
  const now = Date.now();
  // Midpoint of the round trip, for clock skew.
  return { ...body, received_at: Math.round((sent + now) / 2) };
}

export function redeemTicket(ticket: string) {
  return post('/viewer-token', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
}

/** For a visitor without a link: a view-only grant for a bay chosen by the gate, with no priest. */
export function spectate() {
  return post('/spectator-token', {});
}

export function refreshGrant(token: string) {
  return post('/viewer-token/refresh', { headers: { Authorization: `Bearer ${token}` } });
}
