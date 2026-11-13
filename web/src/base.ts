// Where the site is served from: "/" at a domain's root, or a sub-path such as "/indulgence/"
// on GitHub Pages (`vite build --base=/indulgence/`).

/** Vite's base path; "/" where there is no Vite (the demo's scripts run this code in Node). */
const BASE: string = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';

/** The URL of a file in web/public, given its path from the site root ("/audio/x.m4a"). */

export function asset(path: string, base: string = BASE): string {
  return base.replace(/\/+$/, '') + path;
}
