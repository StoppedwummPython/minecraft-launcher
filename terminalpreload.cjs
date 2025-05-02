const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('terminalAPI', {
    sendCommand: () => {
        ipcRenderer.invoke('load-terminal');
    },
    onIncomingData: (callback) => {
        ipcRenderer.on('terminal.incomingData', (event, data) => {
            callback(data);
        });
    },
    onClose: (callback) => {
        ipcRenderer.on('terminal.close', (event) => {
            callback();
        });
    }
});