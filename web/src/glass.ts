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
 * Medieval glass, as light through it: ruby, amber and green above all, with gold, a
 * yellow-green, white, cobalt and azure as accents, a little purple, and a brown for wood.
 * Grounds pair neighbouring hues (ruby with amber, green with leaf, amber with gold), so the
 * colour stays strong when the floor's blur mixes them, rather than going to brown.
 */
export const GLASS = {
  cobalt: [44, 84, 220] as Rgb,
  azure: [86, 136, 238] as Rgb,
  ruby: [222, 40, 48] as Rgb,
  gold: [246, 192, 58] as Rgb,
  amber: [247, 130, 32] as Rgb,
  green: [48, 168, 78] as Rgb,
  leaf: [134, 198, 58] as Rgb,
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
const redGround = mosaic(G.ruby, G.amber, 0.17, 0.3);
const greenGround = mosaic(G.green, G.leaf, 0.17, 0.32);
const amberGround = mosaic(G.amber, G.gold, 0.17, 0.3);

/** The Lamb of God with a halo and a banner of the Resurrection, on a green hill; a star above. */
const agnusDei = lancetWindow('Agnus Dei', [G.green, G.gold], redGround, [
  { shape: circle(0, -0.55, 1.05), colour: G.green },
  { shape: circle(-0.21, 0.94, 0.13), colour: G.gold },
  { shape: bar(-0.09, 0.62, 0.03, 1.66, 0.028), colour: G.gold },
  { shape: bar(-0.04, 1.6, 0.1, 1.6, 0.026), colour: G.gold },
  { shape: cut(box(0.17, 1.37, 0.14, 0.11), polygon([[0.33, 1.25], [0.33, 1.49], [0.22, 1.37]])), colour: G.white },
  { shape: union(box(0.12, 1.37, 0.03, 0.085), box(0.12, 1.37, 0.075, 0.03)), colour: G.ruby },
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
  { shape: circle(0, 2.3, 0.25), colour: G.green },
  { shape: union(box(0, 2.3, 0.11, 0.11), box(0, 2.3, 0.11, 0.11, Math.PI / 4)), colour: G.gold },
]);

/** The Holy Spirit as a dove descending in gold rays onto a great tongue of fire, with two small ones below. */
const pentecost = lancetWindow('Pentecost', [G.ruby, G.amber], greenGround, [
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
const saint = lancetWindow('A saint', [G.green, G.gold], redGround, [
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
const station = lancetWindow('Station II', [G.ruby, G.green], amberGround, [
  { shape: circle(-0.2, -0.9, 1.25), colour: G.green },
  { shape: polygon([[-0.24, 0.34], [0.16, 0.3], [0.02, 1.16], [-0.2, 1.24]]), colour: G.purple },
  { shape: circle(-0.25, 1.22, 0.145), colour: G.gold },
  { shape: intersect(union(box(-0.25, 1.22, 0.14, 0.032), box(-0.25, 1.22, 0.032, 0.14)), circle(-0.25, 1.22, 0.145)), colour: G.ruby },
  { shape: circle(-0.25, 1.2, 0.08), colour: G.white },
  { shape: bar(0.32, 0.28, -0.25, 1.75, 0.045), colour: G.brown },
  { shape: bar(-0.34, 1.43, 0.03, 1.57, 0.04), colour: G.brown },
  { shape: circle(-0.03, 1.02, 0.045), colour: G.white },
  { shape: circle(0, 2.3, 0.26), colour: G.ruby },
  { shape: circle(0, 2.3, 0.2), colour: G.white },
  { shape: union(box(-0.055, 2.3, 0.03, 0.11), box(0.055, 2.3, 0.03, 0.11), box(0, 2.42, 0.11, 0.028), box(0, 2.18, 0.11, 0.028)), colour: G.ruby },
]);

/** Grisaille: pale glass in a lattice of leads, with a green stem through three coloured quatrefoils. */
const grisaille = lancetWindow('Grisaille', [G.ruby, G.amber], mosaic(G.white, G.gold, 0.2, 0.25), [
  { shape: box(0, 1.5, 0.036, 1.5), colour: G.green },
  ...([
    [0.62, G.ruby, G.gold],
    [1.38, G.green, G.ruby],
    [2.14, G.ruby, G.gold],
  ] as [number, Rgb, Rgb][]).flatMap(([y, fill, centre]) => [
    { shape: quatrefoil(0, y, 0.14), colour: G.gold },
    { shape: quatrefoil(0, y, 0.11), colour: fill },
    { shape: circle(0, y, 0.065), colour: centre },
  ]),
  { shape: circle(0, 2.62, 0.075), colour: G.gold },
]);

const goldGround = mosaic(G.gold, G.amber, 0.17, 0.28);
const leafGround = mosaic(G.leaf, G.green, 0.17, 0.35);

/** A lily: three white petals opening upward round a gold stamen. */
const lily = (cx: number, cy: number): Piece[] => [
  { shape: union(ellipse(cx, cy + 0.02, 0.035, 0.1), ellipse(cx - 0.06, cy, 0.03, 0.09, 0.55), ellipse(cx + 0.06, cy, 0.03, 0.09, -0.55)), colour: G.white },
  { shape: circle(cx, cy - 0.05, 0.022), colour: G.gold },
];

/** A cluster of grapes hanging from (cx, cy). */
const grapes = (cx: number, cy: number, colour: Rgb): Piece => ({
  shape: union(
    ...[[0, 0], [-0.05, -0.02], [0.05, -0.02], [-0.025, -0.07], [0.025, -0.07], [0, -0.12]].map(([dx, dy]) => circle(cx + dx!, cy + dy!, 0.033)),
  ),
  colour,
});

/** The Chi-Rho, the monogram of Christ, in a green wreath; a gold star above. */
const chiRho = lancetWindow('Chi-Rho', [G.green, G.gold], redGround, [
  { shape: circle(0, -0.7, 1.0), colour: G.green },
  { shape: cut(circle(0, 1.45, 0.34), circle(0, 1.45, 0.26)), colour: G.green },
  { shape: union(bar(-0.15, 1.27, 0.15, 1.63, 0.035), bar(-0.15, 1.63, 0.15, 1.27, 0.035)), colour: G.gold },
  { shape: union(bar(0, 1.15, 0, 1.78, 0.035), cut(circle(0.07, 1.7, 0.095), circle(0.07, 1.7, 0.045))), colour: G.gold },
  { shape: union(box(0, 2.35, 0.13, 0.13, Math.PI / 4), box(0, 2.35, 0.13, 0.13)), colour: G.gold },
  { shape: circle(0, 2.35, 0.06), colour: G.ruby },
]);

/** The pelican in her piety, feeding her young from her own breast, above her nest. */
const pelican = lancetWindow('Pelican in her piety', [G.ruby, G.amber], greenGround, [
  { shape: ellipse(0, 0.66, 0.3, 0.11), colour: G.gold },
  { shape: union(circle(-0.15, 0.82, 0.055), circle(0, 0.84, 0.055), circle(0.15, 0.82, 0.055)), colour: G.white },
  { shape: union(ellipse(-0.2, 1.42, 0.2, 0.075, 0.6), ellipse(0.22, 1.42, 0.2, 0.075, -0.6)), colour: G.white },
  { shape: union(ellipse(0.02, 1.25, 0.18, 0.26, -0.15), bar(0.08, 1.45, -0.02, 1.7, 0.045), circle(-0.05, 1.74, 0.07)), colour: G.white },
  { shape: bar(-0.07, 1.72, -0.02, 1.4, 0.022), colour: G.gold },
  { shape: union(circle(-0.01, 1.2, 0.03), circle(-0.06, 1.08, 0.028), circle(0.02, 1.02, 0.026)), colour: G.ruby },
  { shape: circle(0, 2.35, 0.2), colour: G.ruby },
  { shape: union(box(0, 2.35, 0.03, 0.13), box(0, 2.38, 0.1, 0.03)), colour: G.gold },
]);

/** The keys of Saint Peter, crossed: one gold, one silver (white). */
const keys = lancetWindow('Keys of Saint Peter', [G.ruby, G.green], amberGround, [
  { shape: box(0, 0.22, 0.4, 0.08), colour: G.green },
  {
    shape: union(bar(-0.2, 0.55, 0.16, 1.9, 0.032), cut(circle(0.19, 2.02, 0.11), circle(0.19, 2.02, 0.05)), box(-0.13, 0.62, 0.07, 0.035, 0.35), box(-0.11, 0.74, 0.06, 0.03, 0.35)),
    colour: G.gold,
  },
  {
    shape: union(bar(0.2, 0.55, -0.16, 1.9, 0.032), cut(circle(-0.19, 2.02, 0.11), circle(-0.19, 2.02, 0.05)), box(0.13, 0.62, 0.07, 0.035, -0.35), box(0.11, 0.74, 0.06, 0.03, -0.35)),
    colour: G.white,
  },
  { shape: circle(0, 2.42, 0.13), colour: G.ruby },
]);

/** The Virgin in a blue mantle holding the Child, both haloed, on red; a star above. */
const madonna = lancetWindow('Madonna and Child', [G.gold, G.green], redGround, [
  { shape: box(0, 0.22, 0.3, 0.08), colour: G.green },
  { shape: polygon([[-0.24, 0.32], [0.24, 0.32], [0.12, 1.56], [-0.12, 1.56]]), colour: G.cobalt },
  { shape: polygon([[-0.08, 0.32], [0.08, 0.32], [0.04, 1.2], [-0.04, 1.2]]), colour: G.white },
  { shape: circle(0, 1.7, 0.16), colour: G.gold },
  { shape: circle(0, 1.68, 0.085), colour: G.white },
  { shape: circle(0.13, 1.4, 0.09), colour: G.gold },
  { shape: ellipse(0.11, 1.18, 0.075, 0.13, 0.2), colour: G.amber },
  { shape: circle(0.13, 1.39, 0.05), colour: G.white },
  { shape: union(box(0, 2.38, 0.11, 0.11, Math.PI / 4), box(0, 2.38, 0.11, 0.11)), colour: G.gold },
]);

/** Saint George: his shield with its red cross, and his lance through the dragon below. */
const george = lancetWindow('Saint George', [G.ruby, G.green], amberGround, [
  { shape: union(cut(ellipse(0, 0.55, 0.3, 0.17), ellipse(0, 0.55, 0.17, 0.07)), circle(0.28, 0.76, 0.065), bar(-0.27, 0.5, -0.36, 0.78, 0.03)), colour: G.green },
  { shape: bar(0.32, 0.78, 0.4, 0.8, 0.015), colour: G.ruby },
  { shape: bar(-0.3, 2.05, 0.27, 0.66, 0.022), colour: G.brown },
  { shape: union(box(0, 1.58, 0.2, 0.24), polygon([[-0.2, 1.35], [0, 1.0], [0.2, 1.35]])), colour: G.white },
  {
    shape: intersect(union(box(0, 1.44, 0.035, 0.42), box(0, 1.6, 0.2, 0.035)), union(box(0, 1.58, 0.2, 0.24), polygon([[-0.2, 1.35], [0, 1.0], [0.2, 1.35]]))),
    colour: G.ruby,
  },
  { shape: circle(0, 2.38, 0.16), colour: G.gold },
  { shape: union(box(0, 2.38, 0.025, 0.1), box(0, 2.38, 0.1, 0.025)), colour: G.ruby },
]);

/** The lilies of the Annunciation, in a gold vase. */
const lilies = lancetWindow('Annunciation lilies', [G.green, G.gold], redGround, [
  { shape: union(ellipse(0, 0.55, 0.17, 0.19), box(0, 0.8, 0.08, 0.08), box(0, 0.36, 0.1, 0.04)), colour: G.gold },
  {
    shape: union(
      bar(0, 0.85, 0, 2.02, 0.022),
      bar(0, 1.0, -0.2, 1.68, 0.02),
      bar(0, 1.0, 0.2, 1.68, 0.02),
      ellipse(-0.1, 1.22, 0.1, 0.035, 0.6),
      ellipse(0.1, 1.32, 0.1, 0.035, -0.6),
      ellipse(-0.07, 1.62, 0.08, 0.03, 0.8),
    ),
    colour: G.green,
  },
  ...lily(0, 2.1),
  ...lily(-0.2, 1.76),
  ...lily(0.2, 1.76),
]);

/** Calvary: three crosses on a green hill, the sun and the moon above. */
const calvary = lancetWindow('Calvary', [G.ruby, G.gold], amberGround, [
  { shape: circle(0, -0.9, 1.25), colour: G.green },
  { shape: union(box(-0.27, 0.72, 0.022, 0.4), box(-0.27, 0.92, 0.1, 0.022), box(0.27, 0.72, 0.022, 0.4), box(0.27, 0.92, 0.1, 0.022)), colour: G.brown },
  { shape: union(box(0, 1.2, 0.04, 0.88), box(0, 1.66, 0.25, 0.04)), colour: G.brown },
  { shape: cut(circle(0, 1.66, 0.085), circle(0, 1.66, 0.05)), colour: G.green },
  { shape: box(0, 1.93, 0.1, 0.04), colour: G.white },
  { shape: circle(-0.19, 2.32, 0.1), colour: G.ruby },
  { shape: cut(circle(0.19, 2.32, 0.1), circle(0.24, 2.36, 0.08)), colour: G.white },
]);

/** The True Vine: a winding vine with leaves and clusters of grapes. */
const vine = lancetWindow('The True Vine', [G.green, G.ruby], goldGround, [
  {
    shape: union(bar(0, 0.2, 0.12, 0.7, 0.03), bar(0.12, 0.7, -0.1, 1.2, 0.03), bar(-0.1, 1.2, 0.1, 1.7, 0.03), bar(0.1, 1.7, -0.05, 2.2, 0.03), bar(-0.05, 2.2, 0, 2.6, 0.03)),
    colour: G.green,
  },
  {
    shape: union(ellipse(0.22, 0.62, 0.1, 0.05, 0.4), ellipse(-0.2, 1.12, 0.1, 0.05, -0.4), ellipse(0.2, 1.62, 0.1, 0.05, 0.4), ellipse(-0.15, 2.12, 0.09, 0.045, -0.4), ellipse(0.1, 2.5, 0.07, 0.04, 0.4)),
    colour: G.leaf,
  },
  grapes(-0.18, 0.9, G.purple),
  grapes(0.21, 1.4, G.ruby),
  grapes(-0.19, 1.9, G.purple),
  grapes(0.17, 2.3, G.ruby),
]);

/** Saint Catherine's wheel, spiked, under a martyr's crown. */
const catherine = lancetWindow("Saint Catherine's wheel", [G.ruby, G.gold], greenGround, [
  { shape: box(0, 0.24, 0.4, 0.09), colour: G.ruby },
  {
    shape: union(
      cut(circle(0, 1.35, 0.3), circle(0, 1.35, 0.23)),
      ...[0, 1, 2, 3, 4, 5].map((k) => bar(0, 1.35, 0.26 * Math.cos((k * Math.PI) / 3), 1.35 + 0.26 * Math.sin((k * Math.PI) / 3), 0.022)),
      ...Array.from({ length: 12 }, (_, k) => {
        const a = (k * Math.PI) / 6 + Math.PI / 12;
        return bar(0.29 * Math.cos(a), 1.35 + 0.29 * Math.sin(a), 0.37 * Math.cos(a), 1.35 + 0.37 * Math.sin(a), 0.018);
      }),
    ),
    colour: G.gold,
  },
  { shape: circle(0, 1.35, 0.065), colour: G.ruby },
  { shape: union(box(0, 2.15, 0.17, 0.045), polygon([[-0.17, 2.19], [-0.09, 2.19], [-0.13, 2.36]]), polygon([[-0.05, 2.19], [0.05, 2.19], [0, 2.42]]), polygon([[0.09, 2.19], [0.17, 2.19], [0.13, 2.36]])), colour: G.gold },
  { shape: circle(0, 2.15, 0.028), colour: G.ruby },
]);

/** The Sacred Heart, aflame, bound with thorns, in a glory of rays. */
const heartShape = union(circle(-0.1, 1.36, 0.12), circle(0.1, 1.36, 0.12), polygon([[-0.215, 1.31], [0, 0.98], [0.215, 1.31]]));
const sacredHeart = lancetWindow('Sacred Heart', [G.ruby, G.amber], leafGround, [
  { shape: union(...Array.from({ length: 9 }, (_, k) => {
    const a = (k * Math.PI) / 8;
    return bar(0, 1.3, 0.36 * Math.cos(a), 1.3 + 0.62 * Math.sin(a), 0.02);
  })), colour: G.gold },
  { shape: flame(0, 1.5, 0.07, 0.32, 0.02), colour: G.amber },
  { shape: flame(0, 1.5, 0.04, 0.2, 0.01), colour: G.gold },
  { shape: heartShape, colour: G.ruby },
  { shape: intersect(heartShape, box(0, 1.27, 0.3, 0.028, -0.12)), colour: G.green },
  { shape: union(box(0, 0.4, 0.3, 0.06), box(0, 0.26, 0.2, 0.04)), colour: G.gold },
]);

/** Every design a window may have. */
export const DESIGNS: WindowDesign[] = [
  agnusDei,
  pentecost,
  saint,
  station,
  grisaille,
  chiRho,
  pelican,
  keys,
  madonna,
  george,
  lilies,
  calvary,
  vine,
  catherine,
  sacredHeart,
];

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
/**
 * Push each pixel's colour away from its own grey by `k`, keeping its brightness, so a pool
 * blurred until its picture is lost still reads as coloured light, not a tinted haze.
 */
export function saturate(px: Float32Array, k: number) {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3]!;
    if (a <= 0) continue;
    const r = px[i]! / a;
    const g = px[i + 1]! / a;
    const b = px[i + 2]! / a;
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    px[i] = clamp(l + (r - l) * k) * a;
    px[i + 1] = clamp(l + (g - l) * k) * a;
    px[i + 2] = clamp(l + (b - l) * k) * a;
  }
}

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
