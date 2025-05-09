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
})