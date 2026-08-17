const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    platform: process.platform,
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    getWindowState: () => ipcRenderer.invoke('window-get-state'),
    onWindowStateChange: (callback) => {
        const handler = (_event, payload) => {
            callback(payload);
        };

        ipcRenderer.on('window-state-changed', handler);
        return () => ipcRenderer.removeListener('window-state-changed', handler);
    },
    openEditor: (request) => ipcRenderer.invoke('desktop-open-editor', request),
    showHub: () => ipcRenderer.invoke('desktop-show-hub'),
    openDesktopAuth: (request) => ipcRenderer.invoke('desktop-open-auth', request),
    cancelDesktopAuth: () => ipcRenderer.invoke('desktop-cancel-auth'),
    openExternalUrl: (url) => ipcRenderer.invoke('desktop-open-external-url', url),
    getPendingAuthCallback: () => ipcRenderer.invoke('desktop-get-pending-auth-callback'),
    getPersistedAuthSession: () => ipcRenderer.invoke('desktop-get-auth-session'),
    persistAuthSession: (session) => ipcRenderer.invoke('desktop-persist-auth-session', session),
    clearPersistedAuthSession: () => ipcRenderer.invoke('desktop-clear-auth-session'),
    onAuthCallback: (callback) => {
        const handler = (_event, payload) => {
            callback(payload);
        };

        ipcRenderer.on('desktop-auth-callback', handler);
        return () => ipcRenderer.removeListener('desktop-auth-callback', handler);
    },
    onHubRefresh: (callback) => {
        const handler = () => {
            callback();
        };

        ipcRenderer.on('desktop-hub-refresh', handler);
        return () => ipcRenderer.removeListener('desktop-hub-refresh', handler);
    },

    // File System Bridges
    saveProject: (data, filename) => ipcRenderer.invoke('save-project', data, filename),
    openProject: () => ipcRenderer.invoke('open-project'),
    selectFiles: () => ipcRenderer.invoke('select-files'),
    readFileFromPath: (filePath) => ipcRenderer.invoke('read-file-from-path', filePath),
    selectDirectory: () => ipcRenderer.invoke('select-directory'),
    scanDirectoryFiles: (request) => ipcRenderer.invoke('scan-directory-files', request),
    transcodeAudio: (request) => ipcRenderer.invoke('transcode-audio', request),
    onBenchmarkStart: (callback) => {
        const handler = (_event, payload) => {
            callback(payload);
        };

        ipcRenderer.on('benchmark-start', handler);
        ipcRenderer.invoke('benchmark-get-config')
            .then((config) => {
                if (config) {
                    callback(config);
                }
            })
            .catch(() => {
                // Non-blocking bootstrap path.
            });

        return () => {
            ipcRenderer.removeListener('benchmark-start', handler);
        };
    },
    publishBenchmarkArtifact: (name, payload) => (
        ipcRenderer.invoke('benchmark-publish-artifact', { name, payload })
    ),
    publishBenchmarkStatus: (status, details) => (
        ipcRenderer.invoke('benchmark-publish-status', { status, details })
    ),
});
