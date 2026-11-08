// A straight, front-facing 3/4 view from the back of the nave toward the altar.
//
// Screen x follows world x (across the endless row of bays); screen y follows world y, from
// the altar at the top of the screen back through rows of pews that continue below the
// bottom edge. Pews are horizontal and parallel; columns and priests stand up from their
// footprint, so things nearer the camera (larger y) are drawn later.

import { C } from '../../shared/constants';

export const TW = C.TILE_W_PX; // 16
export const TH = C.TILE_H_PX; // 12

/**
 * How the pixel-art base canvas maps onto the display. The integer scale is chosen so that
 * about 640 × 360 base pixels fit (a whole bay with both its arcades), then the base canvas
 * grows to cover the whole display, so larger windows simply see more of the cathedral.
 */
export interface Viewport {
  scale: number;
  baseW: number;
  baseH: number;
  /** Display offset of base pixel (0, 0); zero or slightly negative. */
  offX: number;
  offY: number;
}

export function viewportFor(displayW: number, displayH: number): Viewport {
  const scale = Math.max(1, Math.floor(Math.min(displayW / C.BASE_W_PX, displayH / C.BASE_H_PX)));
  const baseW = Math.ceil(displayW / scale);
  const baseH = Math.ceil(displayH / scale);
  return { scale, baseW, baseH, offX: Math.floor((displayW - baseW * scale) / 2), offY: Math.floor((displayH - baseH * scale) / 2) };
}

export interface Camera {
  ox: number;
  oy: number;
}

/** The middle of the bay a world x belongs to: the altar's centre line. */
export function bayCentreX(x: number): number {
  return Math.floor(x / C.BAY_W) * C.BAY_W + C.AISLE_CENTRE_X;
}

/** Centred across on world x `fx`, with the altar at the very top of the screen. */
export function cameraFor(fx: number, vp: Pick<Viewport, 'baseW'>): Camera {
  return { ox: Math.round(vp.baseW / 2 - fx * TW), oy: C.VIEW_TOP_PX };
}

/** Base-canvas position of a world point on the floor. */
export function project(cam: Camera, x: number, y: number): [number, number] {
  return [Math.round(x * TW + cam.ox), Math.round(y * TH + cam.oy)];
}

export function unproject(cam: Camera, bx: number, by: number): [number, number] {
  return [(bx - cam.ox) / TW, (by - cam.oy) / TH];
}

/** Tile ranges that can appear on screen, with margins for tall things and wide pews. */
export function visibleTiles(cam: Camera, vp: Pick<Viewport, 'baseW' | 'baseH'>): { x0: number; x1: number; yMax: number } {
  const [xa] = unproject(cam, 0, 0);
  const [xb, yb] = unproject(cam, vp.baseW, vp.baseH + 80);
  return { x0: Math.floor(xa) - 3, x1: Math.ceil(xb) + 3, yMax: Math.ceil(yb) + 1 };
}

/** Painter's order: back to front by y, then by layer, then left to right. */
export interface Drawable {
  depth: number;
  layer: number;
  x?: number;
  draw(ctx: CanvasRenderingContext2D): void;
}

export const LAYER = { floor: 0, furniture: 1, priest: 2, flame: 3 } as const;

export function sortDrawables(list: Drawable[]): Drawable[] {
  return list.sort((a, b) => a.depth - b.depth || a.layer - b.layer || (a.x ?? 0) - (b.x ?? 0));
}
