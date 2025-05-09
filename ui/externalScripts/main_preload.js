const {ipcRenderer,contextBridge} = require('electron');

contextBridge.exposeInMainWorld('mcAPI', {
    launch: () => {
        ipcRenderer.send('launch');
    },
    downloadToModsFolder: (url) => {
        ipcRenderer.send('downloadToModsFolder', url);
    },
    getModFiles: async () => {
        return await ipcRenderer.invoke('getModsWithMetadata');
    },
    deleteFromModsFolder: (path) => {
        ipcRenderer.send('deleteFromModsFolder', path);
    },
    /**
     * Retrieves the configuration for the client or launcher.
     * 
     * @param {"client" || "launcher"} clientOrLauncher - 'client' or 'launcher'
     * @returns {Promise<Object>} - The configuration object
     */
    getConfig: async (clientOrLauncher) => {
        return await ipcRenderer.invoke('getConfig', clientOrLauncher);
    },

    saveConfig: async (clientOrLauncher, config) => {
        return await ipcRenderer.invoke('saveConfig', clientOrLauncher, config);
    }
})