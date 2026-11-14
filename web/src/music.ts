// Music for the cathedral: Gregorian chant, sung in a nave, from when you open the page.
//
// The recordings (web/public/audio) are dry, and the nave is added here as they play: each is
// convolved with the impulse response that demo/cathedral_reverb.py makes, and mixed as that
// script mixes it. A reverb tail is noise, which compresses badly, while the dry chant
// compresses well and the reverb then covers what compressing it lost. So the chants are under
// a fifth of the size they were with the reverb in the file. One chant's last note also rings
// on into the next.
//
// They play one after another, beginning with the Dies irae, and start again after the last.
// Browsers do not let a page start sound until you have touched it, so if playback is refused
// at first it begins, fading in, on your first click, tap or key press. "Silentium" in the
// bottom left silences it for this visit, and "Musica" brings it back. A build with
// VITE_MUSIC=off (the demos, which have their own soundtrack) has no music and no button.

import { asset } from './base';

/**
 * The chants in the order they are sung. Each is in web/public/audio twice: <name>-opus.mp4,
 * and <name>-aac.m4a (HE-AAC) for a browser that cannot play that. Credits: web/public/audio/README.md and Merita.
 */
export const TRACKS: readonly string[] = [
  'dies-irae',
  'pueri-hebraeorum-portantes',
  'pueri-hebraeorum-vestimenta',
  'improperia',
  'lamentatio',
  'resurrexi',
];
/** The nave: what each chant is convolved with (cathedral_reverb.py --ir). */
export const IMPULSE_RESPONSE = '/audio/impulse-response.m4a';
/** The mix, as cathedral_reverb.py's VIEWER_DRY and VIEWER_WET: the chant as sung, and the nave a little below it. */
export const DRY = 0.55;
export const WET = 0.85 * 0.55;
export const MUSIC_VOLUME = 0.5;
export const FADE_IN_MS = 3000;
export const FADE_OUT_MS = 1200;
/** What may count as touching the page, so that a browser lets sound begin. */
const GESTURES = ['pointerdown', 'pointerup', 'mousedown', 'touchend', 'click', 'keydown'] as const;

/**
 * A chant's files, best first, as paths from the site root: the browser plays the first it can.
 * The Opus is in MP4, not WebM: Safari plays WebM by a way that Web Audio cannot hear, so the
 * nave would be silent, but it plays MP4 as it plays AAC, or declines it and takes the AAC.
 */
export function sources(name: string): { src: string; type: string }[] {
  return [
    { src: `/audio/${name}-opus.mp4`, type: 'audio/mp4; codecs=opus' },
    { src: `/audio/${name}-aac.m4a`, type: 'audio/mp4' },
  ];
}

/** A volume moving in a straight line from `from` to `to` over `durationMs`. */
export function fadeLevel(elapsedMs: number, durationMs: number, from: number, to: number): number {
  if (durationMs <= 0 || elapsedMs >= durationMs) return to;
  if (elapsedMs <= 0) return from;
  return from + (to - from) * (elapsedMs / durationMs);
}

/** The track after track `i`; the first follows the last. */
export function nextTrack(i: number, count: number = TRACKS.length): number {
  return (i + 1) % count;
}

/** The sound on its way out: the chant and the nave's reverb of it, then a gain for the fades. */
interface Nave {
  ctx: AudioContext;
  out: GainNode;
  reverb: ConvolverNode;
  /** Whether the impulse response has been asked for. */
  asked: boolean;
}

/**
 * Route the music through the nave. Null where there is no Web Audio, and the music is then
 * played dry. Made once, on the first try to start.
 */
function buildNave(audio: HTMLAudioElement): Nave | null {
  if (typeof AudioContext === 'undefined') return null;
  try {
    const ctx = new AudioContext();
    const out = new GainNode(ctx, { gain: 0 });
    const dry = new GainNode(ctx, { gain: DRY });
    const reverb = new ConvolverNode(ctx, { disableNormalization: true });
    const rumble = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 70, Q: Math.SQRT1_2 });
    const wet = new GainNode(ctx, { gain: WET });
    dry.connect(out);
    reverb.connect(rumble).connect(wet).connect(out);
    out.connect(ctx.destination);
    // Last, once all else is ready: from here the element is heard only through the context.
    const chant = ctx.createMediaElementSource(audio);
    chant.connect(dry);
    chant.connect(reverb);
    // On an iPhone, Web Audio is silenced by the ring switch unless the page says it is playing
    // media, as an <audio> element on its own would be.
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) session.type = 'playback';
    return { ctx, out, reverb, asked: false };
  } catch {
    return null;
  }
}

/**
 * Fetch the impulse response and hang it in the nave. Until it has come the chant is heard dry,
 * under the fade-in. If it cannot be had, the next start asks again.
 */
function fillNave(nave: Nave) {
  if (nave.asked) return;
  nave.asked = true;
  void fetch(asset(IMPULSE_RESPONSE))
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`impulse response: ${r.status}`))))
    .then((bytes) => nave.ctx.decodeAudioData(bytes))
    .then((buffer) => {
      nave.reverb.buffer = buffer;
    })
    .catch(() => {
      nave.asked = false;
    });
}

/** Whether the context may sound: true once it runs, false if the browser still wants a touch. */
function allowed(ctx: AudioContext): Promise<boolean> {
  if (ctx.state === 'running') return Promise.resolve(true);
  // Before a touch, resume() waits until one comes; give up on it after a second.
  return Promise.race([
    ctx.resume().then(
      () => ctx.state === 'running',
      () => false,
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), 1000)),
  ]);
}

export function setUpMusic(doc: Document = document) {
  if (import.meta.env.VITE_MUSIC === 'off') return;
  const wrap = doc.getElementById('music-wrap');
  const button = doc.getElementById('music') as HTMLButtonElement | null;
  if (!wrap || !button || typeof Audio === 'undefined') return;
  wrap.hidden = false;

  let track = 0;
  const audio = new Audio();
  // Fetch a chant only once it is to be heard: most browsers hold the music back until the
  // first touch, and a visitor who never gives one should not download a megabyte.
  audio.preload = 'none';
  const load = (i: number) => {
    audio.replaceChildren(...sources(TRACKS[i]!).map(({ src, type }) => Object.assign(doc.createElement('source'), { src: asset(src), type })));
    audio.load();
  };
  load(track);
  audio.volume = 0;
  let nave: Nave | null | undefined; // undefined until the first try to start
  // Every visit begins with music; "Silentium" silences this visit only. (The choice used to
  // be remembered, which left the page silent for good after one click.)
  let wanted = true;
  let level = 0;
  let fade = 0;

  const setLevel = (v: number) => {
    level = v;
    // A short glide between the fade's steps, so that they are not heard as steps.
    if (nave) nave.out.gain.setTargetAtTime(v, nave.ctx.currentTime, 0.02);
    else audio.volume = v;
  };

  const label = () => {
    const playing = !audio.paused && wanted;
    button.textContent = playing ? 'Silentium' : 'Musica';
    button.setAttribute('aria-label', playing ? 'Silence the music' : 'Play the music');
  };

  const ramp = (to: number, ms: number, done?: () => void) => {
    window.clearInterval(fade);
    const from = level;
    const t0 = performance.now();
    fade = window.setInterval(() => {
      const t = performance.now() - t0;
      setLevel(Math.max(0, Math.min(1, fadeLevel(t, ms, from, to))));
      if (t >= ms) {
        window.clearInterval(fade);
        done?.();
      }
    }, 50);
  };

  /** Try to start; false if the browser wants a click first. */
  const start = async (): Promise<boolean> => {
    if (nave === undefined) {
      nave = buildNave(audio);
      // The fades are now the nave's; the element itself plays at full volume into it.
      if (nave) audio.volume = 1;
    }
    // Both asked for at once, while any touch that started this still counts.
    const sounding = nave ? allowed(nave.ctx) : Promise.resolve(true);
    try {
      await audio.play();
    } catch {
      label();
      return false;
    }
    if (!(await sounding)) {
      audio.pause();
      label();
      return false;
    }
    if (nave) fillNave(nave);
    ramp(MUSIC_VOLUME, FADE_IN_MS);
    label();
    return true;
  };

  // Until you have touched the page, wait for the first touch, click or key and begin then
  // (but not if it was on the music button itself, whose own click decides). Which events a
  // browser counts as a touch differs: a mouse press does, but on a phone only the end of a
  // tap. So listen for all of them, and keep listening until one is let through.
  let starting = false;
  const stopWaiting = () => {
    for (const type of GESTURES) window.removeEventListener(type, onGesture, true);
  };
  const onGesture = (e: Event) => {
    if (e.target instanceof Node && wrap.contains(e.target)) return;
    if (!wanted || !audio.paused) return stopWaiting();
    if (starting) return;
    starting = true;
    void start().then((ok) => {
      starting = false;
      if (ok) stopWaiting();
    });
  };
  const waitForGesture = () => {
    for (const type of GESTURES) window.addEventListener(type, onGesture, true);
  };

  button.addEventListener('click', () => {
    if (!audio.paused && wanted) {
      wanted = false;
      ramp(0, FADE_OUT_MS, () => {
        audio.pause();
        label();
      });
      label();
    } else {
      wanted = true;
      void start();
    }
  });

  // One chant ends and the next begins, at the volume this one had, while the nave still rings.
  audio.addEventListener('ended', () => {
    track = nextTrack(track);
    load(track);
    if (wanted) void audio.play().catch(() => label());
  });

  label();
  void start().then((ok) => !ok && waitForGesture());
}
