export type SessionDeviceKind = 'desktop' | 'mobile' | 'browser';

export interface SessionDevicePresentation {
  label: string;
  kind: SessionDeviceKind;
}

export function normalizeUserAgent(
  userAgent: string | null | undefined,
  tag: string | null | undefined = null,
): SessionDevicePresentation {
  const value = String(userAgent || '').toLowerCase();
  const identity = `${String(tag || '').toLowerCase()} ${value}`;

  if (/daw[-_ ]?fi[-_ ]?desktop|electron/.test(identity)) {
    return { label: 'DAW-fi Desktop', kind: 'desktop' };
  }

  const browser = value.includes('edg/')
    ? 'Edge'
    : value.includes('firefox/')
      ? 'Firefox'
      : value.includes('chrome/')
        ? 'Chrome'
        : value.includes('safari/')
          ? 'Safari'
          : 'Navegador';

  if (/android|iphone|ipad|mobile/.test(value)) {
    return { label: `${browser} · móvil`, kind: 'mobile' };
  }
  if (/windows|macintosh|linux|x11/.test(value)) {
    return { label: `${browser} · escritorio`, kind: 'desktop' };
  }
  return { label: browser, kind: 'browser' };
}

export function maskSessionIp(ip: string | null | undefined): string {
  if (!ip) return 'No disponible';
  const value = String(ip);
  if (value.includes(':')) {
    const parts = value.split(':').filter(Boolean);
    return `${parts.slice(0, 2).join(':')}:••••`;
  }
  const parts = value.split('.');
  return parts.length === 4 ? `${parts.slice(0, 2).join('.')}.•••.•••` : '••••';
}

export function formatSessionDate(value: string | null | undefined): string {
  if (!value) return 'No disponible';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'No disponible'
    : date.toLocaleString('es-PE', { dateStyle: 'medium', timeStyle: 'short' });
}
