import canned from '../../shared/canned-prayers.json';

/** Pre-1929 public-domain prayers. Strangers see `canned_idx` mod the list length. */
export const CANNED: { name: string; text: string }[] = canned.prayers;

export function cannedPrayer(idx: number): string {
  return CANNED[((idx % CANNED.length) + CANNED.length) % CANNED.length]!.text;
}
