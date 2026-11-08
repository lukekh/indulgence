// 2:1 isometric projection. Tiles are 16 × 8 base pixels; a world point (x, y) is a tile
// centre. x runs along the endless nave (down-right on screen), y from the altar (y = 0,
// top) to the back wall and door (y = 14, bottom).

import { C } from '../../shared/constants';

export const HALF_W = C.TILE_W_PX / 2; // 8
export const HALF_H = C.TILE_H_PX / 2; // 4

export function toScreen(x: number, y: number): [number, number] {
  return [(x - y) * HALF_W, (x + y) * HALF_H];
}

export interface Camera {
  /** Screen-space offset added to projected points so the focus sits mid-canvas. */
  ox: number;
  oy: number;
}

export function cameraFor(fx: number, fy: number): Camera {
  const [sx, sy] = toScreen(fx, fy);
  return { ox: Math.round(C.BASE_W_PX / 2 - sx), oy: Math.round(C.BASE_H_PX / 2 - sy + 20) };
}

export function project(cam: Camera, x: number, y: number): [number, number] {
  const [sx, sy] = toScreen(x, y);
  return [Math.round(sx + cam.ox), Math.round(sy + cam.oy)];
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
