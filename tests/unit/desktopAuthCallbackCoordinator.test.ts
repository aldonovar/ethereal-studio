// @vitest-environment node

import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createAuthCallbackCoordinator } = require(
  '../../electron/desktop-auth-callback-coordinator.cjs',
);

describe('Desktop auth callback coordinator', () => {
  it('shares one in-flight exchange for duplicate callbacks with the same state', async () => {
    const coordinator = createAuthCallbackCoordinator();
    let resolveExchange!: (value: { success: boolean }) => void;
    const exchange = vi.fn(() => new Promise<{ success: boolean }>((resolve) => {
      resolveExchange = resolve;
    }));

    const first = coordinator.run('same-state-digest', exchange);
    const duplicate = coordinator.run('same-state-digest', exchange);

    expect(first).toBe(duplicate);
    expect(exchange).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(exchange).toHaveBeenCalledOnce();

    resolveExchange({ success: true });
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { success: true },
      { success: true },
    ]);
  });

  it('keeps the completed result through the replay window without a second exchange', async () => {
    let now = 1_000;
    const coordinator = createAuthCallbackCoordinator({ ttlMs: 10_000, now: () => now });
    const exchange = vi.fn(async () => ({ success: true }));

    const first = await coordinator.run('same-state-digest', exchange);
    now += 9_999;
    const replay = await coordinator.run('same-state-digest', exchange);

    expect(first).toEqual({ success: true });
    expect(replay).toBe(first);
    expect(exchange).toHaveBeenCalledOnce();
  });

  it('allows a new callback after expiry and retries unexpected rejected work', async () => {
    let now = 1_000;
    const coordinator = createAuthCallbackCoordinator({ ttlMs: 10, now: () => now });
    const exchange = vi.fn()
      .mockRejectedValueOnce(new Error('unexpected failure'))
      .mockResolvedValue({ success: true });

    await expect(coordinator.run('retry-state', exchange)).rejects.toThrow('unexpected failure');
    await expect(coordinator.run('retry-state', exchange)).resolves.toEqual({ success: true });
    expect(exchange).toHaveBeenCalledTimes(2);

    now += 11;
    await expect(coordinator.run('retry-state', exchange)).resolves.toEqual({ success: true });
    expect(exchange).toHaveBeenCalledTimes(3);
  });

  it('does not merge callbacks from different states', async () => {
    const coordinator = createAuthCallbackCoordinator();
    const exchange = vi.fn(async (value: string) => value);

    await expect(Promise.all([
      coordinator.run('state-a', () => exchange('a')),
      coordinator.run('state-b', () => exchange('b')),
    ])).resolves.toEqual(['a', 'b']);
    expect(exchange).toHaveBeenCalledTimes(2);
  });
});
