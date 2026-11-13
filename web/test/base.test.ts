import { describe, expect, it } from 'vitest';
import { asset } from '../src/base';

describe('asset', () => {
  it('is the path itself at the root of a domain', () => {
    expect(asset('/audio/a.m4a', '/')).toBe('/audio/a.m4a');
  });

  it('sits under the base path on a sub-path such as GitHub Pages', () => {
    expect(asset('/audio/a.m4a', '/indulgence/')).toBe('/indulgence/audio/a.m4a');
    expect(asset('/sprites', '/indulgence')).toBe('/indulgence/sprites');
  });
});
