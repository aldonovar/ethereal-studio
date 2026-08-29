// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { formatSessionDate, maskSessionIp, normalizeUserAgent } from '../../services/sessionPresentation';

describe('device-aware session presentation', () => {
  it('identifies DAW-fi Desktop from the exchange user agent or session tag', () => {
    expect(normalizeUserAgent('DAW-fi Desktop')).toEqual({ label: 'DAW-fi Desktop', kind: 'desktop' });
    expect(normalizeUserAgent('node', 'daw-fi-desktop')).toEqual({ label: 'DAW-fi Desktop', kind: 'desktop' });
    expect(normalizeUserAgent('Mozilla/5.0 Chrome/140 Electron/42.0')).toEqual({ label: 'DAW-fi Desktop', kind: 'desktop' });
  });

  it('distinguishes mobile and desktop browsers', () => {
    expect(normalizeUserAgent('Mozilla/5.0 (Linux; Android 16) Chrome/140 Mobile'))
      .toEqual({ label: 'Chrome · móvil', kind: 'mobile' });
    expect(normalizeUserAgent('Mozilla/5.0 (X11; Linux x86_64) Firefox/142.0'))
      .toEqual({ label: 'Firefox · escritorio', kind: 'desktop' });
  });

  it('masks addresses and rejects invalid dates', () => {
    expect(maskSessionIp('192.168.50.21')).toBe('192.168.•••.•••');
    expect(maskSessionIp('2001:db8:85a3::8a2e:370:7334')).toBe('2001:db8:••••');
    expect(maskSessionIp(null)).toBe('No disponible');
    expect(formatSessionDate('not-a-date')).toBe('No disponible');
  });
});
