// Where the site is served from: "/" at a domain's root, or a sub-path such as "/indulgence/"
// on GitHub Pages (`vite build --base=/indulgence/`).

/** The URL of a file in web/public, given its path from the site root ("/audio/x.m4a"). */
export function asset(path: string, base: string = import.meta.env.BASE_URL): string {
  return base.replace(/\/+$/, '') + path;
}
