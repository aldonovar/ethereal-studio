import { describe, expect, it, vi } from 'vitest';

describe('Supabase optional cloud configuration', () => {
  it('keeps the local-first renderer importable without cloud environment variables', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    vi.resetModules();

    const { isSupabaseConfigured, supabase } = await import('../../services/supabase');

    expect(isSupabaseConfigured).toBe(false);
    expect(supabase).toBeDefined();

    vi.unstubAllEnvs();
  });
});
