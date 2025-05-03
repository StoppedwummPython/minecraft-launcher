const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const mainIndex = path.join(__dirname, 'index.js')

const createWindow = () => {
    const win = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'ui', 'externalScripts', 'main_preload.js')
        }
    });

    win.loadFile(path.join(__dirname, 'ui', 'chrome', 'index.html'));
}

const createConsole = () => {
    const consoleWin = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'ui', 'externalScripts', 'console_preload.js')
        }
    });

    consoleWin.loadFile(path.join(__dirname, 'ui', 'chrome', 'console.html'));
    return consoleWin
}

app.whenReady().then(() => {
    ipcMain.on('launch', (event, arg) => {
        let consoleWin = createConsole();
        const process = spawn('node', [mainIndex]);
        
        process.stdout.on('data', (data) => {
            consoleWin.webContents.send('msg', String(data)); // Send to renderer
            console.log(`stdout: ${data}`);
        });
        
        process.stderr.on('data', (data) => {
            consoleWin.webContents.send('error', String(data)); // Send to renderer
            console.error(`stderr: ${data}`);
        });
        
        process.on('close', (code) => {
            console.log(`child process exited with code ${code}`);
        });
        
        process.on('error', (error) => {
            console.error(`Error: ${error}`);
        });
        
        process.on('exit', (code) => {
            console.log(`Process exited with code: ${code}`);
            event.reply('process-exit', code);
            consoleWin.close();
            consoleWin = null;
        });
    });
    createWindow();
});