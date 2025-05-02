import electron from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const { app, BrowserWindow, ipcMain } = electron;
const __dirname = path.dirname(__filename);

let mainWindow;
function openTerminalWindow(command) {
    const termWin = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'terminalpreload.cjs'),
            contextIsolation: true
        }
    });

    termWin.loadFile('terminal.html');

    ipcMain.handle('load-terminal', async () => {
        const cmd = exec(command, async (error, stdout, stderr) => {
            if (error) {
                console.error(`Error executing command: ${error.message}`);
            }
            if (stderr) {
                console.error(`stderr: ${stderr}`);
            }
            if (stdout) {
                ipcMain.emit('terminal.incomingData', null, stdout);
            }
        }
        );
    }
    );
}
const createWindow = () => {
    ipcMain.handle('launch-minecraft', async () => {
        openTerminalWindow('node index.js');
    });
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs')
        },
    });
    mainWindow.loadFile('index.html');
};

app.on('ready', createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});