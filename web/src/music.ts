// Music for the cathedral: Gregorian chant, sung in a nave, from when you open the page.
//
// The recordings (web/public/audio) were put through cathedral_reverb.py. They play one after
// another, beginning with the Dies irae, and start again after the last. Browsers do not let a page start sound until you have
// touched it, so if playback is refused at first it begins, fading in, on your first click or
// key press. "Silentium" in the bottom left silences it, and "Musica" brings it back; the
// choice is remembered. A build with VITE_MUSIC=off (the demos, which have their own
// soundtrack) has no music and no button.

/** The chants in the order they are sung. Credits: web/public/audio/README.md and Merita. */
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
const STORAGE_KEY = 'indulgence:music';

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

function remembered(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

function remember(wanted: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, wanted ? 'on' : 'off');
  } catch {
    // Private windows and blocked storage: the choice lasts until the page closes.
  }
}

export function setUpMusic(doc: Document = document) {
  if (import.meta.env.VITE_MUSIC === 'off') return;
  const wrap = doc.getElementById('music-wrap');
  const button = doc.getElementById('music') as HTMLButtonElement | null;
  if (!wrap || !button || typeof Audio === 'undefined') return;
  wrap.hidden = false;

  let track = 0;
  const audio = new Audio(TRACKS[track]);
  audio.preload = 'auto';
  audio.volume = 0;
  let wanted = remembered();
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

  // Until you have touched the page, wait for the first click or key and begin then (but not
  // if the touch was on the music button itself, whose own click decides).
  const onGesture = (e: Event) => {
    if (e.target instanceof Node && wrap.contains(e.target)) return;
    for (const type of ['pointerdown', 'keydown']) window.removeEventListener(type, onGesture, true);
    if (wanted && audio.paused) void start();
  };
  const waitForGesture = () => {
    for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, onGesture, true);
  };

  button.addEventListener('click', () => {
    if (!audio.paused && wanted) {
      wanted = false;
      remember(false);
      ramp(0, FADE_OUT_MS, () => {
        audio.pause();
        label();
      });
      label();
    } else {
      wanted = true;
      remember(true);
      void start();
    }
  });

  // One chant ends and the next begins, at the volume this one had.
  audio.addEventListener('ended', () => {
    track = nextTrack(track);
    audio.src = TRACKS[track]!;
    if (wanted) void audio.play().catch(() => label());
  });

  label();
  if (wanted) void start().then((ok) => !ok && waitForGesture());
  else waitForGesture();
}
