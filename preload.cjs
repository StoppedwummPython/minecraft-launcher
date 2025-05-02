const { contextBridge } = require('electron');
const { ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  launchMinecraft: () => {
    ipcRenderer.invoke('launch-minecraft');
  },
});