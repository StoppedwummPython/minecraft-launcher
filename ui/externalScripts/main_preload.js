const {ipcRenderer,contextBridge} = require('electron');

contextBridge.exposeInMainWorld('mcAPI', {
    launch: () => {
        ipcRenderer.send('launch');
    },
    downloadToModsFolder: (url) => {
        ipcRenderer.send('downloadToModsFolder', url);
    },
    getModFiles: (url) => {
        ipcRenderer.send('getModFiles', url);
    }
})