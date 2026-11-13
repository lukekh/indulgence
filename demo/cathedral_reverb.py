"""Put a recording in a cathedral: convolve it with a synthesised room impulse response.

The impulse response follows the usual parametric approach (as in Schlecht et al.'s spatial
high-frequency extrapolation work, JASA 145(4), 2019): a late diffuse tail of decaying noise
in octave bands, each band decaying at the rate set by the room's boundary absorption
(Eyring) and the air's absorption, which dominates at high frequencies in a large room; and
discrete early reflections from first- and second-order image sources of a shoebox nave.

    python3 cathedral_reverb.py in.ogg out.wav [seconds] [--loop]

By default the whole recording is used and the reverb tail runs on past its end. With
--loop the tail is wrapped round onto the start instead, so the result is exactly as long as
the recording and, played on repeat, the last chord rings into the first with no gap.
"""

import subprocess
import sys

import numpy as np
from scipy import signal
from scipy.io import wavfile

FS = 48_000
C = 343.0

# A long gothic nave (m).
L, W, H = 90.0, 28.0, 30.0
V = L * W * H
S = 2 * (L * W + L * H + W * H)

BANDS = [125, 250, 500, 1000, 2000, 4000, 8000]
# Average absorption of stone, glass, timber pews and a sparse congregation, per band.
ALPHA = [0.14, 0.13, 0.13, 0.14, 0.15, 0.17, 0.20]
# Air: energy attenuation coefficient m (1/m) at about 20 °C and 50% relative humidity.
AIR_M = [0.0001, 0.0003, 0.0006, 0.0011, 0.0024, 0.0072, 0.0230]

# Choir in the chancel, listener halfway down the nave.
SOURCE = np.array([16.0, 14.0, 2.5])
LISTENER = np.array([58.0, 11.0, 1.7])


def rt60(alpha: float, m: float) -> float:
    """Eyring's reverberation time with air absorption."""
    return 0.161 * V / (-S * np.log(1 - alpha) + 4 * m * V)


def load(path: str, seconds: float | None) -> np.ndarray:
    limit = ["-t", str(seconds)] if seconds else []
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, *limit, "-f", "f32le", "-ac", "2", "-ar", str(FS), "-"],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).astype(np.float64)


def late_tail(seconds: float, rng: np.random.Generator) -> np.ndarray:
    """Decaying band-limited noise, independent in each ear, building up over the mixing time."""
    n = int(seconds * FS)
    t = np.arange(n) / FS
    out = np.zeros((n, 2))
    for f, a, m in zip(BANDS, ALPHA, AIR_M):
        t60 = rt60(a, m)
        lo = f / np.sqrt(2)
        hi = min(f * np.sqrt(2), 0.45 * FS)
        sos = signal.butter(3, [lo, hi], btype="band", fs=FS, output="sos")
        env = np.exp(-6.9078 * t / t60)
        for ch in range(2):
            out[:, ch] += signal.sosfilt(sos, rng.standard_normal(n)) * env
    mixing = np.sqrt(V) / 1000  # mixing time, s
    onset = np.clip((t - 0.02) / mixing, 0, 1) ** 1.5
    return out * onset[:, None]


def image_coordinate(n: int, size: float, s: float) -> float:
    return n * size + s if n % 2 == 0 else (n + 1) * size - s


def early_reflections(n_samples: int) -> np.ndarray:
    """First- and second-order image sources, attenuated by distance and absorption, panned by azimuth."""
    out = np.zeros((n_samples, 2))
    direct = np.linalg.norm(SOURCE - LISTENER)
    r = np.sqrt(1 - ALPHA[3])  # pressure reflection coefficient at 1 kHz
    for nx in range(-2, 3):
        for ny in range(-2, 3):
            for nz in range(-2, 3):
                order = abs(nx) + abs(ny) + abs(nz)
                if order == 0 or order > 2:
                    continue
                img = np.array([image_coordinate(nx, L, SOURCE[0]), image_coordinate(ny, W, SOURCE[1]), image_coordinate(nz, H, SOURCE[2])])
                d = img - LISTENER
                dist = np.linalg.norm(d)
                i = int((dist - direct) / C * FS)  # relative to the direct sound (the dry signal)
                if i <= 0 or i >= n_samples:
                    continue
                g = (direct / dist) * r**order
                pan = np.clip(d[1] / dist, -1, 1)  # across the nave: left/right
                out[i, 0] += g * np.sqrt((1 - pan) / 2)
                out[i, 1] += g * np.sqrt((1 + pan) / 2)
    # Each bounce darkens the sound a little.
    sos = signal.butter(2, 5000, btype="low", fs=FS, output="sos")
    return signal.sosfilt(sos, out, axis=0)


def main():
    args = [a for a in sys.argv[1:] if a != "--loop"]
    loop = "--loop" in sys.argv[1:]
    src, dst = args[0], args[1]
    seconds = float(args[2]) if len(args) > 2 else None  # None: the whole recording
    rng = np.random.default_rng(7)
    for f, a, m in zip(BANDS, ALPHA, AIR_M):
        print(f"  {f:>5} Hz  RT60 {rt60(a, m):.2f} s")

    dry = load(src, seconds)
    tail_s = 1.2 * rt60(ALPHA[0], AIR_M[0])
    late = late_tail(tail_s, rng)
    early = early_reflections(len(late))
    # Early reflections carry about a third of the reverberant energy here.
    late *= np.sqrt(np.sum(early**2) / max(np.sum(late**2), 1e-12)) * 1.7
    ir = early + late
    ir /= np.sqrt(np.sum(ir**2))

    wet = np.stack([signal.oaconvolve(dry[:, ch], ir[:, ch]) for ch in range(2)], axis=1)[: len(dry) + len(ir)]
    if loop:
        # Wrap the tail round onto the start, so the loop point is seamless.
        tail = wet[len(dry):]
        wet = wet[: len(dry)].copy()
        wet[: len(tail)] += tail
    wet = signal.sosfilt(signal.butter(2, 70, btype="high", fs=FS, output="sos"), wet, axis=0)
    dry_padded = np.vstack([dry, np.zeros((len(wet) - len(dry), 2))]) if not loop else dry
    rms = lambda x: np.sqrt(np.mean(x**2)) + 1e-12  # noqa: E731
    wet *= rms(dry) / rms(wet)
    out = 0.55 * dry_padded + 0.85 * wet
    out *= 0.89 / np.max(np.abs(out))  # -1 dBFS peak
    wavfile.write(dst, FS, out.astype(np.float32))
    print(f"wrote {dst}: {len(out) / FS:.1f} s, IR {len(ir) / FS:.1f} s")


if __name__ == "__main__":
    main()
