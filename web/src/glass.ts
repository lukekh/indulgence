// Stained glass. The window light on the floor (scene.ts) is the image of a tall, pointed
// gothic lancet, and each window is one of a few designs a medieval glazier might have made:
// the Lamb of God, Pentecost, a saint under a canopy, a station of the cross, and grisaille
// with quatrefoils. A design is a pure function from a point of the window to the glass
// there, so the floor's glow can be drawn from it (blurred, at low resolution) and the light
// on a priest standing in it can be read exactly, with no canvas.
//
// Inside a design, points are in window units: x across (-0.5 … 0.5, one width) and y up
// from the sill (0) to the apex (LANCET_LENGTH).

export type Rgb = [number, number, number];

/**
 * Medieval glass, as light through it: deep cobalt and ruby above all, with gold and amber,
 * green, a paler blue, white, a little purple, and a brown for wood.
 */
export const GLASS = {
  cobalt: [44, 84, 220] as Rgb,
  azure: [86, 136, 238] as Rgb,
  ruby: [214, 38, 54] as Rgb,
  gold: [244, 188, 66] as Rgb,
  amber: [240, 126, 38] as Rgb,
  green: [56, 158, 86] as Rgb,
  white: [232, 230, 206] as Rgb,
  purple: [134, 64, 166] as Rgb,
  brown: [154, 96, 48] as Rgb,
};
export type GlassName = keyof typeof GLASS;

/** The window's length from sill to apex, in widths: about the shape of its pool on the floor. */
export const LANCET_LENGTH = 3;
/** Radius of the two arcs of the pointed head, in widths: more than one makes a sharp lancet arch. */
const ARCH_RADIUS = 1.25;
/** Where the head springs from the straight sides. */
const SPRING = LANCET_LENGTH - Math.sqrt(ARCH_RADIUS - 0.25);
/** Lead between the pieces of glass, the border of small panes inside the frame, and the iron saddle bars. */
const LEAD = 0.028;
const BORDER = 0.075;
const BORDER_PANE = 0.13;
const BAR = 0.034;
const BARS = [0.75, 1.5, 2.25];
/** The picture's edge: inside the frame's lead, the border and the lead within it. */
const FIELD_INSET = 2 * LEAD + BORDER;

// ---------------------------------------------------------------------------
// Shapes, as signed distances (window units, negative inside)
// ---------------------------------------------------------------------------

type Sdf = (x: number, y: number) => number;

/**
 * The lancet: straight sides up to the springing line, then a pointed head of two arcs, each
 * centred on the springing line beyond the opposite jamb.
 */
export function lancet(x: number, y: number): number {
  if (y <= SPRING) return Math.max(Math.abs(x) - 0.5, -y);
  return Math.hypot(Math.abs(x) + ARCH_RADIUS - 0.5, y - SPRING) - ARCH_RADIUS;
}

/** Whether (u, v) lies inside the window: u along it from sill (0) to apex (1), v across it (0 … 1). */
export function inLancet(u: number, v: number): boolean {
  return lancet(v - 0.5, u * LANCET_LENGTH) < 0;
}

const circle = (cx: number, cy: number, r: number): Sdf => (x, y) => Math.hypot(x - cx, y - cy) - r;

/** An ellipse, turned by `turn` radians (an approximate distance, good enough for leads). */
const ellipse = (cx: number, cy: number, rx: number, ry: number, turn = 0): Sdf => {
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  return (x, y) => {
    const px = (x - cx) * c + (y - cy) * s;
    const py = (y - cy) * c - (x - cx) * s;
    return (Math.hypot(px / rx, py / ry) - 1) * Math.min(rx, ry);
  };
};

/** A rectangle of half-size hw × hh, turned by `turn` radians. */
const box = (cx: number, cy: number, hw: number, hh: number, turn = 0): Sdf => {
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  return (x, y) => {
    const dx = Math.abs((x - cx) * c + (y - cy) * s) - hw;
    const dy = Math.abs((y - cy) * c - (x - cx) * s) - hh;
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
  };
};

/** A bar of radius r from (ax, ay) to (bx, by), rounded at the ends. */
const bar = (ax: number, ay: number, bx: number, by: number, r: number): Sdf => {
  const ex = bx - ax;
  const ey = by - ay;
  const ee = ex * ex + ey * ey;
  return (x, y) => {
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / ee));
    return Math.hypot(x - ax - ex * t, y - ay - ey * t) - r;
  };
};

/** A convex polygon, its corners anticlockwise. */
const polygon = (pts: [number, number][]): Sdf => (x, y) => {
  let d = -Infinity;
  pts.forEach(([ax, ay], i) => {
    const [bx, by] = pts[(i + 1) % pts.length]!;
    const len = Math.hypot(bx - ax, by - ay);
    d = Math.max(d, ((x - ax) * (by - ay) - (y - ay) * (bx - ax)) / len);
  });
  return d;
};

const union = (...shapes: Sdf[]): Sdf => (x, y) => shapes.reduce((d, f) => Math.min(d, f(x, y)), Infinity);
const intersect = (a: Sdf, b: Sdf): Sdf => (x, y) => Math.max(a(x, y), b(x, y));
const cut = (a: Sdf, b: Sdf): Sdf => (x, y) => Math.max(a(x, y), -b(x, y));

/** A pointed arch standing on y = base, half-width hw, its head of radius r springing at `spring`. */
const pointed = (base: number, spring: number, hw: number, r: number): Sdf => (x, y) => {
  if (y <= spring) return Math.max(Math.abs(x) - hw, base - y);
  return Math.hypot(Math.abs(x) + r - hw, y - spring) - r;
};

/** A quatrefoil: four lobes of radius r round (cx, cy). */
const quatrefoil = (cx: number, cy: number, r: number): Sdf =>
  union(circle(cx - r * 0.95, cy, r), circle(cx + r * 0.95, cy, r), circle(cx, cy - r * 0.95, r), circle(cx, cy + r * 0.95, r), box(cx, cy, r * 0.9, r * 0.9));

/** A tongue of fire: round below, drawn up to a point that leans a little to one side. */
const flame = (cx: number, cy: number, r: number, h: number, lean: number): Sdf =>
  union(circle(cx, cy, r), polygon([[cx - r * 0.98, cy + r * 0.2], [cx + r * 0.98, cy + r * 0.2], [cx + lean, cy + h]]));

// ---------------------------------------------------------------------------
// Designs
// ---------------------------------------------------------------------------

/** One piece of glass in a picture, or several cut from the same colour. */
interface Piece {
  shape: Sdf;
  colour: Rgb;
}
type Field = (x: number, y: number) => Rgb | undefined;

export interface WindowDesign {
  name: string;
  /**
   * The glass at (u, v): u along the window from sill (0) to apex (1), v across it (0 … 1).
   * Undefined where no light comes through: outside the window, and on its leads and bars.
   */
  glass(u: number, v: number): Rgb | undefined;
}

/** Integer hash, the same in every browser. */
export function hashInt(n: number): number {
  let h = Math.imul(n | 0, 0x9e3779b1) ^ 0x85ebca6b;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** A ground of small diamond-shaped pieces, mostly `main` with a few of `other`. */
function mosaic(main: Rgb, other: Rgb, size: number, share: number): Field {
  return (x, y) => {
    const p = (x + y) / size;
    const q = (x - y) / size;
    const fp = p - Math.floor(p);
    const fq = q - Math.floor(q);
    if (Math.min(fp, 1 - fp, fq, 1 - fq) * size * Math.SQRT1_2 < LEAD / 2) return undefined;
    return hashInt(Math.floor(p) * 7919 + Math.floor(q) * 104729) < share ? other : main;
  };
}

/**
 * A lancet: the frame's lead, a border of small panes alternating between two colours, the
 * lead inside it, and the picture (pieces back to front over a ground), crossed by saddle bars.
 */
function lancetWindow(name: string, border: [Rgb, Rgb], ground: Field, pieces: Piece[]): WindowDesign {
  const picture = (x: number, y: number): Rgb | undefined => {
    for (let i = pieces.length - 1; i >= 0; i--) {
      const d = pieces[i]!.shape(x, y);
      if (d < -LEAD / 2) return pieces[i]!.colour;
      if (d < LEAD / 2) return undefined;
    }
    return ground(x, y);
  };
  return {
    name,
    glass(u, v) {
      const x = v - 0.5;
      const y = u * LANCET_LENGTH;
      const d = lancet(x, y);
      if (d > -LEAD) return undefined;
      if (d > -(LEAD + BORDER)) {
        // Along the sides by height; across the sill by x.
        const along = y < LEAD + BORDER && Math.abs(x) < 0.5 - LEAD - BORDER ? x + 0.5 : y;
        const k = Math.floor(along / BORDER_PANE);
        if (along - k * BORDER_PANE < LEAD) return undefined;
        return border[k & 1]!;
      }
      if (d > -FIELD_INSET) return undefined;
      if (BARS.some((b) => Math.abs(y - b) < BAR / 2)) return undefined;
      return picture(x, y);
    },
  };
}

const G = GLASS;
const blueGround = mosaic(G.cobalt, G.azure, 0.17, 0.22);

/** The Lamb of God with a halo and a banner of the Resurrection, on a green hill; a star above. */
const agnusDei = lancetWindow('Agnus Dei', [G.ruby, G.gold], blueGround, [
  { shape: circle(0, -0.55, 1.05), colour: G.green },
  { shape: circle(-0.21, 0.94, 0.13), colour: G.gold },
  { shape: bar(-0.09, 0.62, 0.03, 1.66, 0.028), colour: G.gold },
  { shape: bar(-0.04, 1.6, 0.1, 1.6, 0.026), colour: G.gold },
  { shape: cut(box(0.17, 1.37, 0.14, 0.11), polygon([[0.33, 1.25], [0.33, 1.49], [0.22, 1.37]])), colour: G.ruby },
  { shape: union(box(0.12, 1.37, 0.03, 0.085), box(0.12, 1.37, 0.075, 0.03)), colour: G.gold },
  {
    shape: union(
      ellipse(0.03, 0.73, 0.23, 0.13),
      ellipse(-0.21, 0.92, 0.085, 0.065, -0.3),
      bar(-0.13, 0.76, -0.19, 0.89, 0.055),
      bar(-0.13, 0.66, -0.14, 0.49, 0.032),
      bar(-0.05, 0.66, -0.04, 0.5, 0.032),
      bar(0.12, 0.66, 0.13, 0.5, 0.032),
      bar(0.19, 0.68, 0.21, 0.49, 0.032),
      circle(0.26, 0.77, 0.045),
    ),
    colour: G.white,
  },
  { shape: circle(0, 2.3, 0.25), colour: G.ruby },
  { shape: union(box(0, 2.3, 0.11, 0.11), box(0, 2.3, 0.11, 0.11, Math.PI / 4)), colour: G.gold },
]);

/** The Holy Spirit as a dove descending in gold rays onto a great tongue of fire, with two small ones below. */
const pentecost = lancetWindow('Pentecost', [G.gold, G.green], blueGround, [
  { shape: box(0, 0.2, 0.5, 0.11), colour: G.ruby },
  { shape: union(...[-0.26, -0.13, 0, 0.13, 0.26].map((dx) => bar(0, 2.2, dx, 1.55, 0.026))), colour: G.gold },
  { shape: flame(0.02, 1.05, 0.2, 0.78, 0.07), colour: G.ruby },
  { shape: flame(0.02, 1.03, 0.13, 0.52, 0.06), colour: G.amber },
  { shape: flame(0.02, 1.0, 0.07, 0.28, 0.04), colour: G.gold },
  { shape: flame(-0.24, 0.48, 0.07, 0.25, 0.03), colour: G.amber },
  { shape: flame(0.24, 0.48, 0.07, 0.25, -0.03), colour: G.amber },
  { shape: circle(0, 2.42, 0.2), colour: G.gold },
  {
    shape: union(
      ellipse(0, 2.42, 0.06, 0.14),
      circle(0, 2.25, 0.055),
      ellipse(-0.15, 2.5, 0.16, 0.055, 0.45),
      ellipse(0.15, 2.5, 0.16, 0.055, -0.45),
      polygon([[0, 2.52], [0.07, 2.66], [-0.07, 2.66]]),
    ),
    colour: G.white,
  },
]);

/** A saint in a blue robe and green mantle, holding a gold book, haloed, under a canopy, on red. */
const saint = lancetWindow('A saint', [G.cobalt, G.gold], mosaic(G.ruby, G.purple, 0.17, 0.15), [
  { shape: union(box(-0.31, 1.12, 0.032, 0.82), box(0.31, 1.12, 0.032, 0.82)), colour: G.white },
  { shape: cut(box(0, 2.5, 0.5, 0.55), pointed(1.8, 1.95, 0.27, 0.36)), colour: G.white },
  { shape: polygon([[-0.3, 2.36], [0.3, 2.36], [0, 2.8]]), colour: G.gold },
  { shape: circle(0, 2.5, 0.07), colour: G.ruby },
  { shape: box(0, 0.24, 0.26, 0.09), colour: G.green },
  { shape: box(0, 0.36, 0.22, 0.03), colour: G.gold },
  { shape: polygon([[-0.2, 0.39], [0.2, 0.39], [0.12, 1.5], [-0.12, 1.5]]), colour: G.cobalt },
  { shape: polygon([[-0.185, 0.6], [0.06, 0.9], [0.05, 1.45], [-0.124, 1.45]]), colour: G.green },
  { shape: circle(0, 1.66, 0.155), colour: G.gold },
  { shape: circle(0, 1.62, 0.085), colour: G.white },
  { shape: box(0.1, 1.08, 0.065, 0.08, 0.2), colour: G.gold },
  { shape: circle(0.02, 1.15, 0.045), colour: G.white },
]);

/** The second station of the cross: Christ, bowed, takes up the cross; its numeral in a roundel above. */
const station = lancetWindow('Station II', [G.ruby, G.white], blueGround, [
  { shape: circle(-0.2, -0.9, 1.25), colour: G.green },
  { shape: polygon([[-0.24, 0.34], [0.16, 0.3], [0.02, 1.16], [-0.2, 1.24]]), colour: G.purple },
  { shape: circle(-0.25, 1.22, 0.145), colour: G.gold },
  { shape: intersect(union(box(-0.25, 1.22, 0.14, 0.032), box(-0.25, 1.22, 0.032, 0.14)), circle(-0.25, 1.22, 0.145)), colour: G.ruby },
  { shape: circle(-0.25, 1.2, 0.08), colour: G.white },
  { shape: bar(0.32, 0.28, -0.25, 1.75, 0.045), colour: G.brown },
  { shape: bar(-0.34, 1.43, 0.03, 1.57, 0.04), colour: G.brown },
  { shape: circle(-0.03, 1.02, 0.045), colour: G.white },
  { shape: circle(0, 2.3, 0.26), colour: G.gold },
  { shape: circle(0, 2.3, 0.2), colour: G.white },
  { shape: union(box(-0.055, 2.3, 0.03, 0.11), box(0.055, 2.3, 0.03, 0.11), box(0, 2.42, 0.11, 0.028), box(0, 2.18, 0.11, 0.028)), colour: G.ruby },
]);

/** Grisaille: pale glass in a lattice of leads, with a green stem through three coloured quatrefoils. */
const grisaille = lancetWindow('Grisaille', [G.ruby, G.cobalt], mosaic(G.white, G.white, 0.2, 0), [
  { shape: box(0, 1.5, 0.036, 1.5), colour: G.green },
  ...([
    [0.62, G.ruby, G.gold],
    [1.38, G.cobalt, G.ruby],
    [2.14, G.ruby, G.gold],
  ] as [number, Rgb, Rgb][]).flatMap(([y, fill, centre]) => [
    { shape: quatrefoil(0, y, 0.14), colour: G.gold },
    { shape: quatrefoil(0, y, 0.11), colour: fill },
    { shape: circle(0, y, 0.065), colour: centre },
  ]),
  { shape: circle(0, 2.62, 0.075), colour: G.gold },
]);

/** Every design a window may have. */
export const DESIGNS: WindowDesign[] = [agnusDei, pentecost, saint, station, grisaille];

/**
 * The design of a window: the `k`th pool of light in `bay`, from its left- or right-hand
 * wall. The same for every viewer, and a bay's pools never repeat a design.
 */
export function designFor(bay: number, fromLeft: boolean, k: number): WindowDesign {
  const n = DESIGNS.length;
  const seed = bay * 2 + (fromLeft ? 0 : 1);
  const first = Math.floor(hashInt(seed) * n);
  const step = 1 + Math.floor(hashInt(seed + 0x51ed27) * (n - 1));
  return DESIGNS[(first + k * step) % n]!;
}

// ---------------------------------------------------------------------------
// Rasterising, for drawing
// ---------------------------------------------------------------------------

/**
 * Light through glass as pixels: `w` × `h`, premultiplied RGBA (0 … 1), each pixel the mean
 * of `ss` × `ss` samples of `at` (pixel coordinates; undefined lets no light through).
 */
export function rasterise(w: number, h: number, at: (px: number, py: number) => Rgb | undefined, ss = 3): Float32Array {
  const out = new Float32Array(w * h * 4);
  const n = ss * ss;
  for (let py = 0, i = 0; py < h; py++) {
    for (let px = 0; px < w; px++, i += 4) {
      let r = 0;
      let g = 0;
      let b = 0;
      let lit = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = at(px + (sx + 0.5) / ss, py + (sy + 0.5) / ss);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          lit++;
        }
      }
      out[i] = r / 255 / n;
      out[i + 1] = g / 255 / n;
      out[i + 2] = b / 255 / n;
      out[i + 3] = lit / n;
    }
  }
  return out;
}

/** Blur premultiplied RGBA in place: `passes` box blurs of radius `r`, across then down (nearly Gaussian). */
export function blur(px: Float32Array, w: number, h: number, r: number, passes = 3) {
  const line = new Float32Array(Math.max(w, h) * 4);
  const run = (start: number, stride: number, len: number) => {
    for (let i = 0; i < len; i++) for (let c = 0; c < 4; c++) line[i * 4 + c] = px[start + i * stride + c]!;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += i >= 0 && i < len ? line[i * 4 + c]! : 0;
      for (let i = 0; i < len; i++) {
        px[start + i * stride + c] = sum / (2 * r + 1);
        const add = i + r + 1;
        const drop = i - r;
        if (add < len) sum += line[add * 4 + c]!;
        if (drop >= 0) sum -= line[drop * 4 + c]!;
      }
    }
  };
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) run(y * w * 4, 4, w);
    for (let x = 0; x < w; x++) run(x * 4, w * 4, h);
  }
}

/** Premultiplied RGBA (0 … 1) as straight 8-bit pixels for ImageData, its opacity scaled by `alpha` (at most opaque). */
export function toBytes(px: Float32Array, alpha = 1): Uint8ClampedArray {
  const out = new Uint8ClampedArray(px.length);
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3]!;
    if (a <= 0) continue;
    out[i] = (px[i]! / a) * 255;
    out[i + 1] = (px[i + 1]! / a) * 255;
    out[i + 2] = (px[i + 2]! / a) * 255;
    out[i + 3] = a * alpha * 255;
  }
  return out;
}

const covers = new Map<WindowDesign, number>();

/** How much of a window lets light through, between its leads and bars (0 … 1). */
export function lightThrough(design: WindowDesign): number {
  let cover = covers.get(design);
  if (cover === undefined) {
    let inside = 0;
    let lit = 0;
    for (let i = 0; i < 150; i++) {
      for (let j = 0; j < 50; j++) {
        const u = (i + 0.5) / 150;
        const v = (j + 0.5) / 50;
        if (!inLancet(u, v)) continue;
        inside++;
        if (design.glass(u, v)) lit++;
      }
    }
    cover = lit / inside;
    covers.set(design, cover);
  }
  return cover;
}

/** The glass that fills most of a slice of the window, from sill (u0) toward apex (u1). */
export function dominantGlass(design: WindowDesign, u0: number, u1: number): Rgb {
  const counts = new Map<Rgb, number>();
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 24; j++) {
      const c = design.glass(u0 + ((u1 - u0) * (i + 0.5)) / 12, (j + 0.5) / 24);
      if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  let best: Rgb = GLASS.cobalt;
  let most = 0;
  for (const [c, n] of counts) if (n > most) [best, most] = [c, n];
  return best;
}
