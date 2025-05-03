const {ipcRenderer,contextBridge} = require('electron');

contextBridge.exposeInMainWorld('mcAPI', {
    launch: () => {
        ipcRenderer.send('launch');
    }
})