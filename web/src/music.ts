// Music for the cathedral: Gregorian chant, sung in a nave, from when you open the page.
//
// The recordings (web/public/audio) were put through cathedral_reverb.py. They play one after
// another, beginning with the Dies irae, and start again after the last. Browsers do not
// let a page start sound until you have touched it, so if playback is refused at first it
// begins, fading in, on your first click, tap or key press. So that this is the first thing
// you do, the page then opens as a black one with the single word "Intra": press it and you
// are let in, to music. "Silentium" in the bottom left silences it for this visit, and
// "Musica" brings it back. A build with VITE_MUSIC=off (the demos, which have their own
// soundtrack) has no music and no button.

import { asset } from './base';

/** The chants in the order they are sung, as paths from the site root. Credits: web/public/audio/README.md and Merita. */
export const TRACKS: readonly string[] = [
  '/audio/dies-irae-cathedral.m4a',
  '/audio/pueri-hebraeorum-portantes-cathedral.m4a',
  '/audio/pueri-hebraeorum-vestimenta-cathedral.m4a',
  '/audio/improperia-cathedral.m4a',
  '/audio/lamentatio-cathedral.m4a',
  '/audio/resurrexi-cathedral.m4a',
];
export const MUSIC_VOLUME = 0.5;
export const FADE_IN_MS = 3000;
export const FADE_OUT_MS = 1200;
/** How long the black page takes to fade once you are let in; matches #intra's transition. */
export const DOOR_FADE_MS = 900;
/** What may count as touching the page, so that a browser lets sound begin. */
const GESTURES = ['pointerdown', 'pointerup', 'mousedown', 'touchend', 'click', 'keydown'] as const;

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

export interface Music {
  /**
   * Settles once the visitor is in: at once if the music could begin by itself (or there is
   * none), otherwise when they have pressed "Intra". The page waits for this before it
   * plays its opening title.
   */
  entered: Promise<void>;
}

export function setUpMusic(doc: Document = document): Music {
  const door = doc.getElementById('intra') as HTMLButtonElement | null;
  /** Take the black page away: at once, or fading if the visitor has been looking at it. */
  const open = (fading: boolean) => {
    if (!door || door.hidden) return;
    if (!fading) return void (door.hidden = true);
    door.classList.add('opening');
    window.setTimeout(() => (door.hidden = true), DOOR_FADE_MS);
  };
  const wrap = doc.getElementById('music-wrap');
  const button = doc.getElementById('music') as HTMLButtonElement | null;
  if (import.meta.env.VITE_MUSIC === 'off' || !wrap || !button || typeof Audio === 'undefined') {
    open(false);
    return { entered: Promise.resolve() };
  }
  wrap.hidden = false;
  let enter: () => void = () => {};
  const entered = new Promise<void>((r) => (enter = r));

  let track = 0;
  const audio = new Audio(asset(TRACKS[track]!));
  audio.preload = 'auto';
  audio.volume = 0;
  // Every visit begins with music; "Silentium" silences this visit only.
  let wanted = true;
  let fade = 0;

  const label = () => {
    const playing = !audio.paused && wanted;
    button.textContent = playing ? 'Silentium' : 'Musica';
    button.setAttribute('aria-label', playing ? 'Silence the music' : 'Play the music');
  };

  const ramp = (to: number, ms: number, done?: () => void) => {
    window.clearInterval(fade);
    const from = audio.volume;
    const t0 = performance.now();
    fade = window.setInterval(() => {
      const t = performance.now() - t0;
      audio.volume = Math.max(0, Math.min(1, fadeLevel(t, ms, from, to)));
      if (t >= ms) {
        window.clearInterval(fade);
        done?.();
      }
    }, 50);
  };

  /** Try to start; false if the browser wants a click first. */
  const start = async (): Promise<boolean> => {
    try {
      await audio.play();
      ramp(MUSIC_VOLUME, FADE_IN_MS);
      label();
      return true;
    } catch {
      label();
      return false;
    }
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
      if (!ok) return;
      stopWaiting();
      comeIn(true); // a key press lets you in as well as a click
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

  // One chant ends and the next begins, at the volume this one had.
  audio.addEventListener('ended', () => {
    track = nextTrack(track);
    audio.src = asset(TRACKS[track]!);
    if (wanted) void audio.play().catch(() => label());
  });

  // The door: a black page with one word on it. If the browser lets the music begin by
  // itself the door opens unseen. Otherwise "Intra" appears, and pressing it (or any key)
  // is the touch the browser wanted: the music starts and the door fades away.
  const comeIn = (fading: boolean) => {
    open(fading);
    enter();
  };
  door?.addEventListener('click', () => {
    void start();
    comeIn(true);
  });

  label();
  void start().then((ok) => {
    if (ok) return comeIn(false);
    waitForGesture();
    if (door && !door.hidden) door.classList.add('asking');
    else enter();
  });
  return { entered };
}
