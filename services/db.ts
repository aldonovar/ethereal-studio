// VIRTUAL FILE SYSTEM (IndexedDB)
// Stores heavy audio binaries so project files remain lightweight.

const DB_NAME = 'HollowBitsAudioPool';
const LEGACY_DB_NAME = 'EtherealAudioPool';
const STORE_NAME = 'audio_files';
const VERSION = 1;

interface AudioRecord {
    id: string;
    name: string;
    blob: Blob;
    createdAt: number;
}

class AssetDatabase {
    private db: IDBDatabase | null = null;
    private migrationPromise: Promise<void> | null = null;

    async init(): Promise<void> {
        if (this.db) {
            if (this.migrationPromise) {
                await this.migrationPromise;
            }
            return;
        }

        await new Promise<void>((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, VERSION);

            request.onerror = () => reject('Error opening Asset DB');

            request.onsuccess = (event) => {
                this.db = (event.target as IDBOpenDBRequest).result;
                this.migrationPromise = this.migrationPromise || this.migrateLegacyDatabase();
                this.migrationPromise
                    .catch((error) => {
                        console.warn('Legacy asset migration failed.', error);
                    })
                    .finally(() => resolve());
            };

            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                }
            };
        });
    }

    private async migrateLegacyDatabase(): Promise<void> {
        if (!this.db) return;

        const legacyDb = await this.openLegacyDatabase();
        if (!legacyDb) return;

        try {
            if (!legacyDb.objectStoreNames.contains(STORE_NAME)) {
                return;
            }

            const legacyRecords = await this.readAllRecords(legacyDb);
            if (legacyRecords.length === 0) return;

            await this.writeRecords(legacyRecords);
        } finally {
            legacyDb.close();
        }

        try {
            indexedDB.deleteDatabase(LEGACY_DB_NAME);
        } catch {
            // non-blocking cleanup
        }
    }

    private async openLegacyDatabase(): Promise<IDBDatabase | null> {
        return await new Promise<IDBDatabase | null>((resolve) => {
            let createdFresh = false;
            const request = indexedDB.open(LEGACY_DB_NAME, VERSION);

            request.onupgradeneeded = () => {
                createdFresh = true;
            };

            request.onerror = () => resolve(null);

            request.onsuccess = (event) => {
                const legacyDb = (event.target as IDBOpenDBRequest).result;
                if (!createdFresh) {
                    resolve(legacyDb);
                    return;
                }

                legacyDb.close();
                try {
                    indexedDB.deleteDatabase(LEGACY_DB_NAME);
                } catch {
                    // no-op
                }
                resolve(null);
            };
        });
    }

    private async readAllRecords(db: IDBDatabase): Promise<AudioRecord[]> {
        return await new Promise<AudioRecord[]>((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAll();

            request.onsuccess = () => {
                const records = Array.isArray(request.result) ? request.result : [];
                const sanitized = records.filter((record): record is AudioRecord => {
                    return Boolean(
                        record
                        && typeof record.id === 'string'
                        && typeof record.name === 'string'
                        && record.blob instanceof Blob
                        && Number.isFinite(record.createdAt)
                    );
                });
                resolve(sanitized);
            };

            request.onerror = () => reject('Failed to read legacy VFS records');
        });
    }

    private async writeRecords(records: AudioRecord[]): Promise<void> {
        if (!this.db || records.length === 0) return;

        await new Promise<void>((resolve, reject) => {
            const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);

            records.forEach((record) => {
                store.put(record);
            });

            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject('Failed writing migrated VFS records');
            transaction.onabort = () => reject('Aborted writing migrated VFS records');
        });
    }

    async saveFile(file: File | Blob, knownBuffer?: ArrayBuffer): Promise<string> {
        if (!this.db) await this.init();

        const buffer = knownBuffer && knownBuffer.byteLength === file.size
            ? knownBuffer
            : await file.arrayBuffer();
        const hash = await this.computeHash(buffer);

        return await new Promise((resolve, reject) => {
            const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);

            const check = store.get(hash);

            check.onsuccess = () => {
                if (check.result) {
                    resolve(hash);
                    return;
                }

                const fileName = file instanceof File ? file.name : 'Unknown Audio';
                const record: AudioRecord = {
                    id: hash,
                    name: fileName,
                    blob: file instanceof Blob ? file : new Blob([file]),
                    createdAt: Date.now()
                };

                const addRequest = store.add(record);
                addRequest.onsuccess = () => resolve(hash);
                addRequest.onerror = () => reject('Failed to write to VFS');
            };

            check.onerror = () => reject('DB read error');
        });
    }

    async getFile(hash: string): Promise<Blob | null> {
        if (!this.db) await this.init();

        return await new Promise((resolve) => {
            const transaction = this.db!.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(hash);

            request.onsuccess = () => {
                if (request.result) resolve(request.result.blob);
                else resolve(null);
            };

            request.onerror = () => resolve(null);
        });
    }

    private async computeHash(buffer: ArrayBuffer): Promise<string> {
        const hashBuffer = await crypto.subtle.digest('SHA-1', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map((value) => value.toString(16).padStart(2, '0')).join('');
    }
}

export const assetDb = new AssetDatabase();
