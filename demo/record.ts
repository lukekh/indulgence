// Scripted end-to-end demo of /indulgence.
//
//   npm run gif      record demo/out/indulgence-demo.gif (headless Chrome + ffmpeg)
//   npm run live     play the same demo in a visible Chrome window
//   npm run sandbox  boot the same cathedral, print a viewer link, run until Ctrl+C
//
// Each run starts from nothing: a fresh in-memory SpacetimeDB on a free port, the module
// published to it, the viewer built and served, and the real gate seeded with you, three
// friends praying and two friends' votive candles. Everything is torn down afterwards.

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { startCathedral, type Cathedral, type Layout } from './scenario.js';
import { cameraFor, project, viewportFor } from '../web/src/iso.js';
import { candleDrawable } from '../web/src/scene.js';
import { nextPassAt, thurifersBetween } from '../web/src/npc.js';
import { C, type CandleName } from '../shared/constants.js';

const MODE: 'gif' | 'live' | 'sandbox' = process.argv.includes('--live') ? 'live' : process.argv.includes('--sandbox') ? 'sandbox' : 'gif';
const HEADLESS = MODE === 'gif' || process.env.DEMO_HEADLESS === '1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.resolve(process.env.DEMO_OUT ?? path.join(HERE, 'out', 'indulgence-demo.gif'));
const FPS = Number(process.env.DEMO_FPS ?? 8);
/** Playback speed of the (slow, minute-long) departure in the GIF. */
const FAST = Number(process.env.DEMO_DEPART_SPEED ?? 2);
// 1440 × 900 renders the cathedral at 3× (its base canvas is 480 × 270); 1000 × 660 gives 2×.
const WIDTH = Number(process.env.DEMO_WIDTH ?? 1440);
const HEIGHT = Number(process.env.DEMO_HEIGHT ?? 900);
const INTENTION = process.env.DEMO_INTENTION ?? 'for the soul of my cat';
const BUDGET = 20_000;
const MODULE = 'indulgence-demo';
const ENV = { ...process.env, PATH: `${path.join(os.homedir(), '.local', 'bin')}:${process.env.PATH}` };

const t0 = Date.now();
const say = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function need(cmd: string, hint: string) {
  try {
    execFileSync('which', [cmd], { env: ENV, stdio: 'ignore' });
  } catch {
    throw new Error(`${cmd} not found. ${hint}`);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(url: string, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${url}`);
}

const children: ChildProcess[] = [];
let tmpDir: string | undefined;
function start(cmd: string, args: string[], opts: { cwd: string; log: string; env?: NodeJS.ProcessEnv }) {
  const out = fs.openSync(opts.log, 'a');
  const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? ENV, stdio: ['ignore', out, out] });
  children.push(child);
  return child;
}

function run(cmd: string, args: string[], opts: { cwd: string; log: string; env?: NodeJS.ProcessEnv }) {
  const out = fs.openSync(opts.log, 'a');
  try {
    execFileSync(cmd, args, { cwd: opts.cwd, env: opts.env ?? ENV, stdio: ['ignore', out, out] });
  } catch {
    throw new Error(`${cmd} ${args[0]} failed; see ${opts.log}`);
  }
}

/** Page coordinates of things in the viewer, using the renderer's own projection. */
function aimer(box: { x: number; y: number; width: number; height: number }, own: Layout['own']) {
  const vp = viewportFor(box.width, box.height);
  const { scale, offX, offY } = vp;
  const cam = cameraFor(own.x, own.y, vp);
  const toPage = (bx: number, by: number) => ({ x: box.x + offX + bx * scale, y: box.y + offY + by * scale });
  return {
    // Aim at the upper body: lower down, the priest kneeling in front can overlap.
    priest: (p: { x: number; y: number }) => {
      const [fx, fy] = project(cam, p.x, p.y);
      return toPage(fx, fy - 20);
    },
    /** The thurifer nearest your seat right now, if one is in the nave near you. */
    thurifer: () => {
      const near = thurifersBetween(Date.now(), own.x - 30, own.x + 30).sort((a, b) => Math.abs(a.x - own.x) - Math.abs(b.x - own.x))[0];
      if (!near) return undefined;
      const [fx, fy] = project(cam, near.x + 1.5, near.y);
      return toPage(fx, fy - 20);
    },
    candle: (c: Layout['candles'][string]) => {
      const d = candleDrawable(cam, { arcade: c.arcade, slot: c.slot, size: c.size as CandleName, litAt: 0, expiresAt: 0 }, 0, false);
      const [x, y, w, h] = d.hit;
      return toPage(x + w / 2, y + h / 2);
    },
  };
}

async function main() {
  need('spacetime', 'Install it from https://spacetimedb.com/install.');
  need('cargo', 'Install Rust (rustup); module/rust-toolchain.toml pins the version.');
  if (MODE === 'gif') need('ffmpeg', 'Install it, e.g. `brew install ffmpeg`.');
  for (const pkg of ['gate', 'web']) {
    if (!fs.existsSync(path.join(ROOT, pkg, 'node_modules'))) throw new Error(`Run \`npm install\` in ${pkg}/ first.`);
  }

  const tmp = fs.mkdtempSync(path.join(HERE, '.cache', 'run-'));
  tmpDir = tmp;
  const log = path.join(tmp, 'demo.log');
  let browser: Browser | undefined;
  let cathedral: Cathedral | undefined;
  try {
    const [stdbPort, gatePort, webPort] = [await freePort(), await freePort(), await freePort()];
    const stdbUrl = `http://127.0.0.1:${stdbPort}`;
    const site = `http://localhost:${webPort}`;

    say(`starting SpacetimeDB on :${stdbPort}`);
    start('spacetime', ['start', '--in-memory', '--listen-addr', `127.0.0.1:${stdbPort}`, '--data-dir', path.join(tmp, 'stdb'), '--non-interactive'], { cwd: tmp, log });
    await waitFor(`${stdbUrl}/v1/ping`, 60_000);

    say('publishing the module');
    run('spacetime', ['publish', MODULE, '--server', stdbUrl, '--module-path', path.join(ROOT, 'module'), '--anonymous', '--yes'], {
      cwd: ROOT,
      log,
      env: { ...ENV, INDULGENCE_ISSUER: `http://localhost:${gatePort}`, INDULGENCE_AUDIENCE: MODULE },
    });

    say('building and serving the viewer');
    const vite = path.join(ROOT, 'web', 'node_modules', 'vite', 'bin', 'vite.js');
    const webOut = path.join(tmp, 'web');
    run(process.execPath, [vite, 'build', '--outDir', webOut, '--emptyOutDir', '--logLevel', 'warn'], {
      cwd: path.join(ROOT, 'web'),
      log,
      env: { ...ENV, VITE_GATE_URL: `http://localhost:${gatePort}` },
    });
    start(process.execPath, [vite, 'preview', '--outDir', webOut, '--port', String(webPort), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(ROOT, 'web'), log });
    await waitFor(`http://127.0.0.1:${webPort}/`, 30_000);

    say('starting the gate and seating the congregation');
    cathedral = await startCathedral({
      gatePort,
      siteUrl: site,
      stdbUri: `ws://127.0.0.1:${stdbPort}`,
      module: MODULE,
      youLogin: process.env.DEMO_LOGIN ?? 'you',
      strangers: Number(process.env.DEMO_STRANGERS ?? 18),
      log: (l) => say(l),
    });

    if (MODE === 'sandbox') {
      const begun = await cathedral.begin(INTENTION, BUDGET);
      console.log(`\n  Your priest: ${begun.url}\n  (single-use link; ${'Ctrl+C'} departs everyone and shuts down)\n`);
      for (let i = 0; ; i++) {
        const r = await cathedral.pray(i);
        if (r.done) break;
        await sleep(2000);
      }
      return;
    }

    // Start so that a thurifer (one passes every two minutes) enters the view just after the
    // cathedral opens, and only once the friends who lit votives have walked out.
    const lead = 16_000;
    const startAt = nextPassAt(-20, Math.max(Date.now(), cathedral.readyAt) + lead) - lead;
    if (startAt > Date.now() + 1000) say(`waiting ${Math.round((startAt - Date.now()) / 1000)} s for the votive-lighters to leave and the thurifer to come round`);
    await sleep(startAt - Date.now());

    say(`opening Chrome (${HEADLESS ? 'headless' : 'visible'}${MODE === 'gif' ? ', recording' : ''})`);
    browser = await chromium.launch({ channel: 'chrome', headless: HEADLESS }).catch(() => chromium.launch({ headless: HEADLESS }));
    const page: Page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    await page.goto(`${pathToFileURL(path.join(HERE, 'stage.html')).href}?w=${WIDTH}&h=${HEIGHT}`);

    // ---- recorder -----------------------------------------------------------------
    const framesDir = path.join(tmp, 'frames');
    fs.mkdirSync(framesDir);
    const frames: { t: number; file: string }[] = [];
    const fast: [number, number][] = [];
    let recording = MODE === 'gif';
    const recorder = (async () => {
      for (let i = 0; recording; i++) {
        const t = Date.now();
        const file = path.join(framesDir, `f${String(i).padStart(5, '0')}.png`);
        fs.writeFileSync(file, await page.screenshot({ type: 'png' }));
        frames.push({ t, file });
        const wait = 1000 / FPS - (Date.now() - t);
        if (wait > 0) await sleep(wait);
      }
    })();

    // ---- the scene ------------------------------------------------------------------
    say('scene: boot the gate, run /indulgence');
    await sleep(600);
    await page.evaluate((p) => (window as any).stage.bootGate(p), gatePort);
    await sleep(700);
    await page.evaluate((c) => (window as any).stage.typeCommand(c), `/indulgence 20k ${INTENTION}`);
    await page.evaluate(([i, b]) => (window as any).stage.beginSpinner(i, b), [INTENTION, BUDGET] as const);
    await sleep(900);

    const begun = await cathedral.begin(INTENTION, BUDGET); // your priest starts walking in now
    const begunAt = Date.now();
    await page.evaluate(([t, u]) => (window as any).stage.showBegin(t, u), [begun.text, begun.url] as const);
    let departed = false;
    const praying = (async () => {
      await sleep(3500);
      for (let i = 0; i < 3 && !departed; i++) {
        const r = await cathedral!.pray(i);
        await page.evaluate((x) => (window as any).stage.prayed(x), r).catch(() => {});
        if (r.done) break;
      }
    })();
    await sleep(700);
    await page.evaluate((s) => (window as any).stage.showSubagent(s), begun.session_id);
    await sleep(700);

    say('scene: open the cathedral');
    await page.evaluate((u) => (window as any).stage.openBrowser(u), begun.url);
    const view = page.frameLocator('#frame').locator('#view');
    await view.waitFor();
    await sleep(9000);

    const layout = await cathedral.layout();
    const box = await view.boundingBox();
    if (box) {
      const aim = aimer(box, layout.own);
      const hover = async (p: { x: number; y: number } | undefined, ms: number) => {
        if (!p) return;
        await page.mouse.move(p.x, p.y, { steps: 18 });
        await sleep(ms);
      };
      say('scene: friends, their votives and the thurifer');
      await hover(layout.friends.Hildegard && aim.priest(layout.friends.Hildegard), 3400);
      await hover(layout.candles.Bede && aim.candle(layout.candles.Bede), 2700);
      await hover(layout.candles.Clare && aim.candle(layout.candles.Clare), 2700);
      await hover(aim.thurifer(), 3200);
      await hover({ x: box.x + box.width - 20, y: box.y + 40 }, 2500);
    }

    // Walking in at a solemn 1 tile/s takes up to half a minute; leave only once seated.
    await sleep(Math.max(0, begunAt + 32_000 - Date.now()));
    say('scene: depart, light a candle, Ite, missa est');
    const fastFrom = Date.now();
    departed = true;
    await cathedral.depart();
    await sleep(C.PRIEST_REMOVE_AFTER_MS + 3500);
    fast.push([fastFrom, Date.now() - 2500]);
    await page.evaluate(() => (window as any).stage.closeBrowser());
    await sleep(800);
    await page.evaluate(() => (window as any).stage.finish());
    await sleep(2500);
    recording = false;
    await recorder;
    await Promise.race([praying, sleep(1000)]);

    if (MODE === 'gif') {
      say(`encoding ${frames.length} frames`);
      const speed = (t: number) => (fast.some(([a, b]) => t >= a && t < b) ? FAST : 1);
      const list = frames.map((f, i) => {
        const next = frames[i + 1]?.t ?? f.t + 1000 / FPS;
        return `file '${f.file}'\nduration ${((next - f.t) / 1000 / speed(f.t)).toFixed(4)}`;
      });
      list.push(`file '${frames.at(-1)!.file}'`);
      fs.writeFileSync(path.join(tmp, 'frames.txt'), list.join('\n'));
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      run(
        'ffmpeg',
        [
          '-y',
          '-f', 'concat',
          '-safe', '0',
          '-i', path.join(tmp, 'frames.txt'),
          '-vf', `fps=${FPS},split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
          '-loop', '0',
          OUT,
        ],
        { cwd: tmp, log },
      );
      say(`wrote ${path.relative(process.cwd(), OUT)} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
    }
  } finally {
    await browser?.close().catch(() => {});
    await cathedral?.stop().catch(() => {});
    for (const c of children) c.kill('SIGTERM');
    if (process.env.DEMO_KEEP_TMP) say(`kept ${tmp}`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }
}

fs.mkdirSync(path.join(HERE, '.cache'), { recursive: true });
main().then(
  () => process.exit(0),
  (e) => {
    console.error(`demo failed: ${(e as Error).message}`);
    for (const c of children) c.kill('SIGTERM');
    process.exit(1);
  },
);
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    for (const c of children) c.kill('SIGTERM');
    if (tmpDir && !process.env.DEMO_KEEP_TMP) fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(130);
  });
}
