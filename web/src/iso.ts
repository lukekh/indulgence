// 2:1 isometric projection. Tiles are 16 × 8 base pixels; a world point (x, y) is a tile
// centre. x runs along the endless nave (down-right on screen), y from the altar (y = 0,
// top) to the back wall and door (y = 14, bottom).

import { C } from '../../shared/constants';

export const HALF_W = C.TILE_W_PX / 2; // 8
export const HALF_H = C.TILE_H_PX / 2; // 4

export function toScreen(x: number, y: number): [number, number] {
  return [(x - y) * HALF_W, (x + y) * HALF_H];
}

/**
 * How the pixel-art base canvas maps onto the display. The integer scale is chosen so that
 * about 480 × 270 base pixels fit, then the base canvas grows to cover the whole display
 * (no letterboxing), so wider or taller windows simply see more of the cathedral.
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
  /** Screen-space offset added to projected points so the focus sits mid-canvas. */
  ox: number;
  oy: number;
}

export function cameraFor(fx: number, fy: number, vp: Pick<Viewport, 'baseW' | 'baseH'>): Camera {
  const [sx, sy] = toScreen(fx, fy);
  return { ox: Math.round(vp.baseW / 2 - sx), oy: Math.round(vp.baseH / 2 - sy + 20) };
}

export function project(cam: Camera, x: number, y: number): [number, number] {
  const [sx, sy] = toScreen(x, y);
  return [Math.round(sx + cam.ox), Math.round(sy + cam.oy)];
}

/** World point under a base-canvas pixel (on the floor plane). */
export function unproject(cam: Camera, bx: number, by: number): [number, number] {
  const u = (bx - cam.ox) / HALF_W; // x - y
  const v = (by - cam.oy) / HALF_H; // x + y
  return [(u + v) / 2, (v - u) / 2];
}

/** Tile ranges that can appear on screen, with a margin for tall things. */
export function visibleTiles(cam: Camera, vp: Pick<Viewport, 'baseW' | 'baseH'>): { x0: number; x1: number; yMax: number } {
  const corners = [
    unproject(cam, 0, 0),
    unproject(cam, vp.baseW, 0),
    unproject(cam, 0, vp.baseH + 60),
    unproject(cam, vp.baseW, vp.baseH + 60),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return { x0: Math.floor(Math.min(...xs)) - 3, x1: Math.ceil(Math.max(...xs)) + 3, yMax: Math.ceil(Math.max(...ys)) + 2 };
}

/** Painter's order: back to front by x + y, then by layer. */
export interface Drawable {
  depth: number;
  layer: number;
  draw(ctx: CanvasRenderingContext2D): void;
}

export const LAYER = { floor: 0, furniture: 1, priest: 2, flame: 3 } as const;

export function sortDrawables(list: Drawable[]): Drawable[] {
  return list.sort((a, b) => a.depth - b.depth || a.layer - b.layer);
}
