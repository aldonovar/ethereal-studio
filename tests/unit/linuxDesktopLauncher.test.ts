// @vitest-environment node

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const launcher = fs.readFileSync(
    path.resolve(process.cwd(), 'scripts/launch-dawfi-desktop.sh'),
    'utf8'
);

describe('DAW-fi Linux desktop launcher', () => {
    it('disables only Vulkan on native Wayland to avoid black Electron surfaces', () => {
        expect(launcher).toContain('XDG_SESSION_TYPE');
        expect(launcher).toContain('WAYLAND_DISPLAY');
        expect(launcher).toContain('electron_args+=(--disable-features=Vulkan)');
        expect(launcher).not.toContain('electron_args+=(--disable-gpu)');
    });

    it('preserves secure-session and callback arguments alongside display hardening', () => {
        expect(launcher).toContain('electron_args+=(--password-store=gnome-libsecret)');
        expect(launcher).toContain('"${electron_args[@]}"');
        expect(launcher).toContain('"$@"');
    });
});
