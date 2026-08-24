// @vitest-environment node
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  attachTrustedNavigation,
  isTrustedRendererUrl,
  requireTrustedIpcSender,
} = require('../../electron/native-bridge-security.cjs') as {
  attachTrustedNavigation: (win: any, trusted: (url: string) => boolean) => void;
  isTrustedRendererUrl: (url: string, options: Record<string, unknown>) => boolean;
  requireTrustedIpcSender: (event: any, options: Record<string, unknown>) => unknown;
};

describe('native bridge sender policy', () => {
  it('accepts only the exact packaged renderer file or the configured dev origin', () => {
    const rendererFilePath = '/opt/dawfi/dist/index.html';
    expect(isTrustedRendererUrl(
      'file:///opt/dawfi/dist/index.html?surface=editor',
      { rendererFilePath, isDev: false },
    )).toBe(true);
    expect(isTrustedRendererUrl(
      'file:///opt/dawfi/dist/other.html',
      { rendererFilePath, isDev: false },
    )).toBe(false);
    expect(isTrustedRendererUrl(
      'http://localhost:3000/?surface=editor',
      { isDev: true, devOrigin: 'http://localhost:3000' },
    )).toBe(true);
    expect(isTrustedRendererUrl(
      'https://attacker.example/',
      { isDev: true, devOrigin: 'http://localhost:3000' },
    )).toBe(false);
  });

  it('requires the registered role, main frame and trusted URL', () => {
    const mainFrame = { url: 'file:///opt/dawfi/dist/index.html?surface=editor' };
    const sender = { id: 17, mainFrame };
    const roles = new Map([[17, 'editor']]);
    const options = {
      roles,
      allowedRoles: ['editor'],
      isTrustedUrl: (url: string) => url.startsWith('file:///opt/dawfi/dist/index.html'),
    };

    expect(() => requireTrustedIpcSender({ sender, senderFrame: mainFrame }, options)).not.toThrow();
    expect(() => requireTrustedIpcSender({
      sender,
      senderFrame: { url: mainFrame.url },
    }, options)).toThrowError(/no está autorizada/i);
    expect(() => requireTrustedIpcSender({ sender, senderFrame: mainFrame }, {
      ...options,
      allowedRoles: ['hub'],
    })).toThrowError(/no está autorizada/i);
    expect(() => requireTrustedIpcSender({
      sender,
      senderFrame: { ...mainFrame, url: 'https://attacker.example/' },
    }, options)).toThrow();
  });

  it('blocks untrusted navigation and denies renderer-created windows', () => {
    let navigationHandler: ((event: { preventDefault: () => void }, url: string) => void) | undefined;
    let windowOpenHandler: (() => { action: string }) | undefined;
    const win = {
      webContents: {
        on: vi.fn((name: string, handler: typeof navigationHandler) => {
          if (name === 'will-navigate') navigationHandler = handler;
        }),
        setWindowOpenHandler: vi.fn((handler: typeof windowOpenHandler) => {
          windowOpenHandler = handler;
        }),
      },
    };
    attachTrustedNavigation(win, (url) => url.startsWith('file:///trusted/index.html'));

    const trustedPrevent = vi.fn();
    navigationHandler!({ preventDefault: trustedPrevent }, 'file:///trusted/index.html?surface=hub');
    expect(trustedPrevent).not.toHaveBeenCalled();
    const deniedPrevent = vi.fn();
    navigationHandler!({ preventDefault: deniedPrevent }, 'https://attacker.example/');
    expect(deniedPrevent).toHaveBeenCalledTimes(1);
    expect(windowOpenHandler!()).toEqual({ action: 'deny' });
  });
});
