import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

export interface ActiveSession {
  id: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_active: string;
  tag: string | null;
  is_current: boolean;
}

export interface SessionMutationResult {
  revoked: boolean;
  reason: string;
}

function readJwtSessionId(accessToken: string | null | undefined): string | null {
  if (!accessToken) return null;
  try {
    const payload = accessToken.split('.')[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
    const sessionId = (JSON.parse(decoded) as { session_id?: unknown }).session_id;
    return typeof sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(sessionId) ? sessionId : null;
  } catch {
    return null;
  }
}

export function normalizeUserAgent(userAgent: string | null | undefined): { label: string; kind: 'desktop' | 'mobile' | 'browser' } {
  const value = String(userAgent || '').toLowerCase();
  const browser = value.includes('edg/') ? 'Edge' : value.includes('firefox/') ? 'Firefox' : value.includes('chrome/') ? 'Chrome' : value.includes('safari/') ? 'Safari' : 'Navegador';
  if (/android|iphone|ipad|mobile/.test(value)) return { label: `${browser} · móvil`, kind: 'mobile' };
  if (/electron/.test(value)) return { label: 'DAW-fi Desktop', kind: 'desktop' };
  if (/windows|macintosh|linux|x11/.test(value)) return { label: `${browser} · escritorio`, kind: 'desktop' };
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
  return Number.isNaN(date.getTime()) ? 'No disponible' : date.toLocaleString('es-PE', { dateStyle: 'medium', timeStyle: 'short' });
}

export async function loadActiveSessions(session: Session | null): Promise<ActiveSession[]> {
  if (!session) return [];
  const currentId = readJwtSessionId(session.access_token);
  const modern = await supabase.rpc('get_active_sessions_v2');
  if (!modern.error && modern.data) {
    return (modern.data as ActiveSession[]).map((item) => ({
      ...item,
      is_current: Boolean(item.is_current || (currentId && item.id === currentId)),
      last_active: item.last_active || item.created_at,
    }));
  }
  const legacy = await supabase.rpc('get_active_sessions');
  if (legacy.error || !legacy.data) throw legacy.error || modern.error || new Error('No se pudieron cargar las sesiones.');
  return (legacy.data as Array<Omit<ActiveSession, 'tag' | 'is_current'>>).map((item) => ({
    ...item,
    tag: null,
    is_current: Boolean(currentId && item.id === currentId),
    last_active: item.last_active || item.created_at,
  }));
}

export async function revokeRemoteSession(sessionId: string): Promise<SessionMutationResult> {
  const modern = await supabase.rpc('revoke_device_session_v2', { target_session_id: sessionId });
  if (!modern.error && modern.data) {
    const result = Array.isArray(modern.data) ? modern.data[0] : modern.data;
    return { revoked: Boolean(result?.revoked), reason: String(result?.reason || '') };
  }
  const legacy = await supabase.rpc('revoke_device_session', { target_session_id: sessionId });
  if (legacy.error) throw legacy.error || modern.error;
  return { revoked: Boolean(legacy.data), reason: legacy.data ? 'revoked' : 'not_found' };
}
