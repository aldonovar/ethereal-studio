const DEFAULT_CALLBACK_DEDUPE_TTL_MS = 10 * 60 * 1000;

const createAuthCallbackCoordinator = ({
    ttlMs = DEFAULT_CALLBACK_DEDUPE_TTL_MS,
    now = Date.now,
} = {}) => {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || typeof now !== 'function') {
        throw new TypeError('Desktop auth callback coordinator configuration is invalid.');
    }

    const entries = new Map();

    const prune = () => {
        const currentTime = Number(now());
        for (const [key, entry] of entries.entries()) {
            if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= currentTime) {
                entries.delete(key);
            }
        }
    };

    const run = (stateDigest, execute) => {
        if (typeof execute !== 'function') {
            throw new TypeError('Desktop auth callback execution must be a function.');
        }

        const key = typeof stateDigest === 'string' ? stateDigest.trim() : '';
        if (!key) {
            return Promise.resolve().then(execute);
        }

        prune();
        const existing = entries.get(key);
        if (existing) return existing.promise;

        const promise = Promise.resolve().then(execute);
        const entry = {
            expiresAt: Number(now()) + ttlMs,
            promise,
        };
        entries.set(key, entry);

        // Unexpected failures may be retried. Normal auth outcomes are handled
        // inside main.cjs and therefore remain cached for the full replay window.
        void promise.catch(() => {
            if (entries.get(key) === entry) entries.delete(key);
        });

        return promise;
    };

    return {
        prune,
        run,
        get size() {
            prune();
            return entries.size;
        },
    };
};

module.exports = {
    DEFAULT_CALLBACK_DEDUPE_TTL_MS,
    createAuthCallbackCoordinator,
};
