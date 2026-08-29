import { afterEach, vi } from 'vitest';

const createMemoryStorage = (): Storage => {
    const entries = new Map<string, string>();

    return {
        get length() {
            return entries.size;
        },
        clear() {
            entries.clear();
        },
        getItem(key: string) {
            return entries.get(String(key)) ?? null;
        },
        key(index: number) {
            return Array.from(entries.keys())[index] ?? null;
        },
        removeItem(key: string) {
            entries.delete(String(key));
        },
        setItem(key: string, value: string) {
            entries.set(String(key), String(value));
        }
    };
};

// Node 26 defines an unavailable global localStorage unless a backing file is
// configured. Vitest will otherwise preserve that undefined global instead of
// exposing jsdom's storage, causing every browser-domain test to fail at setup.
const testStorage = createMemoryStorage();
Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: testStorage
});

if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: testStorage
    });
}

afterEach(() => {
    vi.restoreAllMocks();
    testStorage.clear();
});
