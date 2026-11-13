// A 1080p demo video of /indulgence, for YouTube.
//
//   VIDEO_AUDIO=/path/to/music.wav npx tsx video.ts      (or: npm run video, from the root)
//
// The music is yours to supply (none is in the repo). To put it in a cathedral first, run
// it through cathedral_reverb.py (see demo/README.md). The module is built with the video's
// seating (INDULGENCE_VIDEO_SEATING=1) and the cathedral cast for the video (`video: true`).
//
// Like record.ts, every run starts from nothing (a fresh SpacetimeDB, the module, the
// viewer and the real gate), but it records a longer, more faithful session: Claude Code
// alone in the terminal (no gate pane), the cathedral at 2× on 1920 × 1080 so the next
// bay shows on either side, a visible mouse, the priest praying for most of a minute, and
// music underneath. Frames come from Chrome's screencast (~30 fps) and are encoded with
// ffmpeg to H.264 + AAC.

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { startCathedral, type Cathedral, type Layout } from './scenario.js';
import { bayCentreX, cameraFor, project, viewportFor, visibleTiles } from '../web/src/view.js';
import { candleDrawable } from '../web/src/scene.js';
import { keyRowCentre } from '../web/src/key.js';
import { sentences } from '../web/src/recital.js';
import { textSize } from '../web/src/text.js';
import { nextPassAt, thurifersBetween } from '../web/src/npc.js';
import { C, type CandleName } from '../shared/constants.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.resolve(process.env.VIDEO_OUT ?? path.join(os.homedir(), 'Movies', 'indulgence-demo.mp4'));
const AUDIO = process.env.VIDEO_AUDIO;
const W = 1920;
const H = 1080;
const FPS = 30;
/** Playback speed of the long walks (the rest of the walk in, and the departure). */
const FAST = 2;
/** Real time watching your priest pray once it has sat down. */
const SEATED_MS = Number(process.env.VIDEO_SEATED_MS ?? 55_000);
const INTENTION = 'for the soul of my cat';
const BUDGET = 20_000;
const YOU = process.env.VIDEO_LOGIN ?? 'lukekh';
const SITE = process.env.VIDEO_SITE ?? 'https://indulgence.example';
const MODULE = 'indulgence-video';
const ENV = { ...process.env, PATH: `${path.join(os.homedir(), '.local', 'bin')}:${process.env.PATH}` };
/** From opening Chrome to the cathedral appearing, and to the mouse reaching the thurifer. */
const OPENS_AFTER_MS = 9_000;
const THURIFER_AT_MS = 34_000;

const t0 = Date.now();
const say = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

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
      if ((await fetch(url)).status < 500) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${url}`);
}

const children: ChildProcess[] = [];
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

type Box = { x: number; y: number; width: number; height: number };

function seatedTime(box: Box, own: Layout['own'], begunAt: number): number {
  const vp = viewportFor(box.width, box.height);
  const cam = cameraFor(bayCentreX(own.x), vp);
  const entryY = Math.max(C.ENTRY_Y, visibleTiles(cam, vp).yMax + 2);
  const bayStart = bayCentreX(own.x) - C.AISLE_CENTRE_X;
  const side = bayStart + (own.x < bayCentreX(own.x) ? C.SIDE_AISLE_X[0]! : C.SIDE_AISLE_X[1]!);
  return begunAt + ((entryY - own.y + Math.abs(own.x - side)) / C.WALK_TILES_PER_S) * 1000;
}

function aimer(box: Box, own: Layout['own'], shift: number) {
  const vp = viewportFor(box.width, box.height);
  const { scale, offX, offY } = vp;
  const cam = cameraFor(bayCentreX(own.x), vp);
  const toPage = (bx: number, by: number) => ({ x: box.x + offX + bx * scale, y: box.y + offY + by * scale });
  return {
    scale,
    keyRow: (i: number) => {
      const c = keyRowCentre(box.width, Math.round(textSize(scale) * 0.85), i);
      return { x: box.x + c.x, y: box.y + c.y };
    },
    priest: (p: { x: number; y: number }) => {
      const [fx, fy] = project(cam, p.x, p.y);
      return toPage(fx, fy - 20);
    },
    thurifer: () => {
      const near = thurifersBetween(Date.now() + shift, own.x - 30, own.x + 30).sort((a, b) => Math.abs(a.x - own.x) - Math.abs(b.x - own.x))[0];
      if (!near) return undefined;
      const [fx, fy] = project(cam, near.x + 0.3, near.y);
      return toPage(fx, fy - 14);
    },
    candle: (c: Layout['candles'][string]) => {
      const d = candleDrawable(cam, { arcade: c.arcade, slot: c.slot, size: c.size as CandleName, litAt: 0, expiresAt: 0 }, 0, false);
      const [x, y, w, h] = d.hit;
      return toPage(x + w / 2, y + h / 2);
    },
  };
}

/** Chrome's screencast, every other compositor frame (~30 fps), timestamped on arrival. */
async function startScreencast(page: Page, dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames: { t: number; file: string }[] = [];
  let n = 0;
  cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number }) => {
    const file = path.join(dir, `f${String(n++).padStart(6, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
    frames.push({ t: Date.now(), file });
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 2 });
  return {
    frames,
    async stop() {
      await cdp.send('Page.stopScreencast').catch(() => {});
      await sleep(200);
      return frames;
    },
  };
}

/** A mouse the viewer can see: moved smoothly, drawn by the stage over everything. */
function mouse(page: Page) {
  let at = { x: W * 0.8, y: H * 0.86 };
  const show = (x: number, y: number) => page.evaluate(([a, b]) => (window as any).stage.pointer(a, b), [x, y] as const);
  return {
    async init() {
      await page.mouse.move(at.x, at.y);
      await show(at.x, at.y);
    },
    async to(p: { x: number; y: number } | undefined, ms = 700) {
      if (!p) return;
      const from = at;
      const t1 = Date.now();
      for (;;) {
        const k = Math.min(1, (Date.now() - t1) / ms);
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        const x = from.x + (p.x - from.x) * e;
        const y = from.y + (p.y - from.y) * e;
        await page.mouse.move(x, y);
        await show(x, y);
        if (k >= 1) break;
        await sleep(12);
      }
      at = { x: p.x, y: p.y };
    },
    async click() {
      await page.evaluate(([a, b]) => (window as any).stage.click(a, b), [at.x, at.y] as const);
      await page.mouse.click(at.x, at.y);
    },
    get at() {
      return at;
    },
  };
}

async function main() {
  if (!AUDIO || !fs.existsSync(AUDIO)) throw new Error('Set VIDEO_AUDIO to the music (a .wav; see demo/README.md for putting it in a cathedral first).');
  fs.mkdirSync(path.join(HERE, '.cache'), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(HERE, '.cache', 'video-'));
  const log = path.join(tmp, 'video.log');
  let browser: Browser | undefined;
  let cathedral: Cathedral | undefined;
  try {
    const [stdbPort, gatePort, webPort] = [await freePort(), await freePort(), await freePort()];
    const stdbUrl = `http://127.0.0.1:${stdbPort}`;
    say(`starting SpacetimeDB on :${stdbPort}`);
    start('spacetime', ['start', '--in-memory', '--listen-addr', `127.0.0.1:${stdbPort}`, '--data-dir', path.join(tmp, 'stdb'), '--non-interactive'], { cwd: tmp, log });
    await waitFor(`${stdbUrl}/v1/ping`, 60_000);
    say('publishing the module');
    run('spacetime', ['publish', MODULE, '--server', stdbUrl, '--module-path', path.join(ROOT, 'module'), '--anonymous', '--yes'], {
      cwd: ROOT,
      log,
      env: { ...ENV, INDULGENCE_ISSUER: `http://localhost:${gatePort}`, INDULGENCE_AUDIENCE: MODULE, INDULGENCE_VIDEO_SEATING: '1' },
    });

    say('starting the gate and seating the congregation');
    cathedral = await startCathedral({
      gatePort,
      siteUrl: `http://localhost:${webPort}`,
      stdbUri: `ws://127.0.0.1:${stdbPort}`,
      module: MODULE,
      youLogin: YOU,
      strangers: Number(process.env.VIDEO_STRANGERS ?? 13),
      video: true,
      log: (l) => say(l),
    });

    // Open once the friends who lit votives have walked out; shift the thurifers'
    // procession so one is crossing the front of your bay when the mouse goes to it.
    const startAt = Math.max(Date.now() + 5000, cathedral.readyAt - OPENS_AFTER_MS);
    const friendX = Object.values((await cathedral.layout()).friends)[0]?.x ?? C.AISLE_CENTRE_X;
    const at = startAt + THURIFER_AT_MS;
    const shift = nextPassAt(bayCentreX(friendX) - 20, at) - at;

    say('building and serving the viewer');
    const vite = path.join(ROOT, 'web', 'node_modules', 'vite', 'bin', 'vite.js');
    const webOut = path.join(tmp, 'web');
    run(process.execPath, [vite, 'build', '--outDir', webOut, '--emptyOutDir', '--logLevel', 'warn'], {
      cwd: path.join(ROOT, 'web'),
      log,
      env: { ...ENV, VITE_GATE_URL: `http://localhost:${gatePort}`, VITE_DEMO_THURIFER_SHIFT_MS: String(Math.round(shift)), VITE_MUSIC: 'off' },
    });
    start(process.execPath, [vite, 'preview', '--outDir', webOut, '--port', String(webPort), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(ROOT, 'web'), log });
    await waitFor(`http://127.0.0.1:${webPort}/`, 30_000);

    say(`waiting ${Math.round((startAt - Date.now()) / 1000)} s for the votive-lighters to leave`);
    await sleep(startAt - Date.now());

    say('opening Chrome and recording');
    browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => chromium.launch({ headless: true }));
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    await page.goto(`${pathToFileURL(path.join(HERE, 'stage.html')).href}?w=${W}&h=${H}&video=1&site=${encodeURIComponent(SITE)}`);
    const m = mouse(page);
    await m.init();
    const rec = await startScreencast(page, path.join(tmp, 'frames'));
    const fast: [number, number][] = [];
    const stage = (fn: string, ...args: unknown[]) => page.evaluate(([f, a]) => (window as any).stage[f as string](...(a as unknown[])), [fn, args] as const);

    // ---- Claude Code: /indulgence ------------------------------------------------------
    say('scene: /indulgence in Claude Code');
    await sleep(1200);
    await stage('typeCommand', `/indulgence 20k ${INTENTION}`);
    await stage('beginSpinner', INTENTION, BUDGET);
    await sleep(1100);
    const begun = await cathedral.begin(INTENTION, BUDGET); // your priest starts walking in
    const begunAt = Date.now();
    await stage('showBegin', begun.text, begun.url);
    let departed = false;
    let said: string[] = [];
    const praying = (async () => {
      await sleep(3500);
      for (let i = 0; !departed; i++) {
        const r = await cathedral!.pray(i);
        if (r.accepted) said = [...said, ...sentences(r.text)].slice(-5);
        await stage('prayed', r, said).catch(() => {});
        if (r.done) break;
      }
    })();
    await sleep(900);
    await stage('showSubagent', begun.session_id);
    await sleep(1400);

    // Open the link from the terminal.
    const link = await page.locator('#claude .blue').last().boundingBox();
    if (link) await m.to({ x: link.x + Math.min(link.width - 20, 220), y: link.y + link.height / 2 }, 900);
    await sleep(300);
    await m.click();
    await stage('openBrowser', begun.url);
    const view = page.frameLocator('#frame').locator('#view');
    await view.waitFor();
    say('scene: the cathedral');
    await m.to({ x: W * 0.9, y: H * 0.9 }, 900);
    await sleep(7600); // the title, over the cathedral, then it fades

    const layout = await cathedral.layout();
    const box = (await view.boundingBox())!;
    const seatedAt = seatedTime(box, layout.own, begunAt);
    const aim = aimer(box, layout.own, shift);
    const pause = (ms: number) => sleep(ms);
    say(`seated at +${Math.round((seatedAt - begunAt) / 1000)} s; friends ${Object.keys(layout.friends).join(', ')}; ${layout.strangers.length} strangers`);

    // ---- the tour ---------------------------------------------------------------------------
    const friends = Object.keys(layout.friends).sort((a, b) => a.localeCompare(b));
    const first = friends[0];
    if (first) {
      await m.to(aim.priest(layout.friends[first]!), 1100);
      await pause(3200);
    }
    const second = friends[1];
    if (second) {
      await m.to(aim.keyRow(friends.indexOf(second)), 1200);
      await pause(500);
      await m.click();
      await pause(3000);
    }
    const votives = Object.keys(layout.candles);
    if (votives[0]) {
      await m.to(aim.candle(layout.candles[votives[0]]!), 1300);
      await pause(2800);
    }
    // Keep the mouse on the thurifer as it walks, so its details stay up.
    await m.to(aim.thurifer(), 1300);
    for (const until = Date.now() + 3600; Date.now() < until; ) await m.to(aim.thurifer(), 120);
    await m.to({ x: box.x + 240, y: box.y + box.height - 160 }, 900);

    // The notices: Latin first, then English.
    const viewer = page.frameLocator('#frame');
    const centre = async (selector: string) => {
      const b = await viewer.locator(selector).boundingBox();
      return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : undefined;
    };
    await m.to(await centre('button[data-open="repudiationes"]'), 700);
    await pause(700);
    await m.click();
    await pause(2600);
    await m.to(await centre('button[data-lang="en"]'), 700);
    await m.click();
    await pause(2600);
    await m.to(await centre('[data-close]'), 600);
    await m.click();
    await pause(500);
    await m.to(await centre('button[data-open="merita"]'), 900);
    await pause(600);
    await m.click();
    await pause(3200);
    await m.to(await centre('[data-close]'), 600);
    await m.click();
    await pause(400);
    await m.to({ x: W * 0.9, y: H * 0.88 }, 1000);

    // ---- your priest takes its seat and prays --------------------------------------------
    const waitFrom = Date.now();
    await sleep(seatedAt - 3000 - Date.now());
    if (Date.now() - waitFrom > 1500) fast.push([waitFrom, Date.now()]);
    say('scene: your priest prays');
    await sleep(seatedAt + 20_000 - Date.now());
    // A stranger, named only by vestment, and their prayer.
    const ownPage = aim.priest(layout.own);
    const stranger = layout.strangers
      .map((s) => ({ s, p: aim.priest(s) }))
      .filter(({ p }) => p.x > box.x + 80 && p.x < box.x + box.width - 80 && p.y > box.y + 120 && Math.hypot(p.x - ownPage.x, p.y - ownPage.y) > 220)
      .sort((a, b) => Math.hypot(a.p.x - ownPage.x, a.p.y - ownPage.y) - Math.hypot(b.p.x - ownPage.x, b.p.y - ownPage.y))[0];
    if (stranger) {
      await m.to(stranger.p, 1300);
      await pause(4000);
      await m.to({ x: W * 0.9, y: H * 0.88 }, 1100);
    }
    await sleep(seatedAt + SEATED_MS - Date.now());

    // ---- departure ---------------------------------------------------------------------------
    say('scene: depart, light a candle, Ite, missa est');
    const fastFrom = Date.now();
    departed = true;
    await cathedral.depart();
    await sleep(C.PRIEST_REMOVE_AFTER_MS + 6000);
    fast.push([fastFrom, Date.now() - 5500]);
    await stage('closeBrowser');
    await sleep(900);
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    await stage('finish', `~/.claude/indulgence/prayers/${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${begun.session_id.slice(0, 8)}.md`);
    await sleep(4500);
    const frames = await rec.stop();
    await Promise.race([praying, sleep(1000)]);

    // ---- encode --------------------------------------------------------------------------------
    say(`encoding ${frames.length} frames`);
    const speed = (t: number) => (fast.some(([a, b]) => t >= a && t < b) ? FAST : 1);
    let total = 0;
    const list = frames.map((f, i) => {
      const next = frames[i + 1]?.t ?? f.t + 1000 / FPS;
      const dur = (next - f.t) / 1000 / speed(f.t);
      total += dur;
      return `file '${f.file}'\nduration ${dur.toFixed(5)}`;
    });
    list.push(`file '${frames.at(-1)!.file}'`);
    fs.writeFileSync(path.join(tmp, 'frames.txt'), list.join('\n'));
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const D = total.toFixed(3);
    run(
      'ffmpeg',
      [
        '-y',
        '-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'frames.txt'),
        '-i', AUDIO,
        '-filter_complex',
        `[0:v]fps=${FPS},format=yuv420p,fade=t=in:st=0:d=0.8,fade=t=out:st=${(total - 2).toFixed(3)}:d=2[v];` +
          `[1:a]atrim=0:${D},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=2.5,afade=t=out:st=${(total - 5).toFixed(3)}:d=5,loudnorm=I=-18:TP=-2:LRA=11,aresample=48000[a]`,
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-tune', 'animation', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        OUT,
      ],
      { cwd: tmp, log },
    );
    say(`wrote ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB, ${Math.round(total)} s)`);
  } finally {
    await browser?.close().catch(() => {});
    await cathedral?.stop().catch(() => {});
    for (const c of children) c.kill('SIGTERM');
    if (process.env.VIDEO_KEEP_TMP) say(`kept ${tmp}`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`video failed: ${(e as Error).message}`);
    for (const c of children) c.kill('SIGTERM');
    process.exit(1);
  },
);
