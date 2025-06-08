const { ipcRenderer, contextBridge } = require('electron');

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
    },
    getModpacks: async () => {
        return await ipcRenderer.invoke('getModpacks');
    },
    createModpack: async (modpack) => {
        return await ipcRenderer.invoke('createModpack', modpack);
    },
    getModsFromModpack: async (modpack) => {
        return await ipcRenderer.invoke('getModsFromModpack', modpack);
    },
    updateModpack: async (modpack) => {
        return await ipcRenderer.invoke('updateModpack', modpack);
    },
    installModpack: async (modpack) => {
        return await ipcRenderer.invoke('installModpack', modpack);
    },
    deleteModpack: async (modpack) => {
        return await ipcRenderer.invoke('deleteModpack', modpack);
    },
    getAllVersionFiles: async () => {
        return await ipcRenderer.invoke('getAllVersionFiles');
    }
})