const {ipcRenderer,contextBridge} = require('electron');

contextBridge.exposeInMainWorld('mcAPI', {
    onMessage: (callback) => {
        ipcRenderer.on('msg', (event, arg) => {
            callback(arg);
        });
    },
    onError: (callback) => {
        ipcRenderer.on('error', (event, arg) => {
            callback(arg);
        });
    }
});