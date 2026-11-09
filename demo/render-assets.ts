// Renders every asset of the viewer to JPEGs for review, using the viewer's own drawing
// code: the cathedral, the altar, the pews, a votive stand, the stained-glass windows, each
// vestment of priest in every pose, and the thurifer.
//
//   npm run assets     writes demo/out/assets/*.jpg (about 15 seconds)
//
// Serves demo/assets/ with Vite (sprites and font from web/public) and saves each sheet
// from headless Chrome. Needs `npm install` in web/ (for Vite) and here (for Playwright).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.resolve(process.env.ASSETS_OUT ?? path.join(HERE, 'out', 'assets'));

type ViteServer = { listen(): Promise<unknown>; close(): Promise<void>; resolvedUrls: { local: string[] } | null };

async function main() {
  const viteEntry = path.join(ROOT, 'web', 'node_modules', 'vite', 'dist', 'node', 'index.js');
  if (!fs.existsSync(viteEntry)) throw new Error('Run `npm install` in web/ first.');
  const vite = (await import(pathToFileURL(viteEntry).href)) as { createServer(config: object): Promise<ViteServer> };
  const server = await vite.createServer({
    configFile: false,
    root: path.join(HERE, 'assets'),
    publicDir: path.join(ROOT, 'web', 'public'),
    cacheDir: path.join(HERE, '.cache', 'vite-assets'),
    logLevel: 'warn',
    server: { host: '127.0.0.1', port: 0, fs: { allow: [ROOT] } },
  });
  let browser: Browser | undefined;
  try {
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (!url) throw new Error('Vite did not start');
    browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
    await page.goto(url);
    await page.waitForFunction(() => {
      const a = (window as any).assets;
      return a && (a.ready || a.error);
    }, null, { timeout: 60_000 });
    const error = await page.evaluate(() => (window as any).assets.error as string);
    if (error) throw new Error(error);
    const names = await page.evaluate(() => (window as any).assets.names as string[]);
    fs.mkdirSync(OUT, { recursive: true });
    for (const name of names) {
      const data = await page.evaluate((n) => (window as any).assets.jpeg(n) as string, name);
      const file = path.join(OUT, `${name}.jpg`);
      fs.writeFileSync(file, Buffer.from(data.split(',')[1]!, 'base64'));
      console.log(`wrote ${path.relative(process.cwd(), file)} (${Math.round(fs.statSync(file).size / 1000)} kB)`);
    }
  } finally {
    await browser?.close().catch(() => {});
    await server.close();
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`assets failed: ${(e as Error).message}`);
    process.exit(1);
  },
);
