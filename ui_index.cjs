// main.js

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// New dependencies for reading mod metadata
const AdmZip = require('adm-zip');
const toml = require('@iarna/toml');

// Path to your non-UI entry point
const mainIndex = path.join(__dirname, 'index.js');

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'ui', 'externalScripts', 'main_preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, 'ui', 'chrome', 'index.html'));
}

function createConsole() {
  const consoleWin = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'ui', 'externalScripts', 'console_preload.js'),
    },
  });

  consoleWin.loadFile(path.join(__dirname, 'ui', 'chrome', 'console.html'));
  return consoleWin;
}

/**
 * Extracts NeoForge/Fabric mod metadata from a .jar/.zip
 * Priorities:
 *  1. META-INF/neoforge.mods.toml
 *  2. META-INF/mods.toml (legacy)
 *  3. fabric.mod.json
 *  4. META-INF/MANIFEST.MF
 */
function getModMetadata(jarPath) {
  const zip = new AdmZip(jarPath);

  // 1. NeoForge TOML
  let entry = zip.getEntry('META-INF/neoforge.mods.toml');
  if (entry) {
    const raw = entry.getData().toString('utf8');
    const parsed = toml.parse(raw);
    return parsed.mods.map(mod => ({
      id: mod.modId,
      version: mod.version,
      name: mod.displayName,
      description: mod.description,
      authors: mod.authors,
      dependencies: mod.dependencies || {},
    }));
  }

  // 2. Legacy mods.toml
  entry = zip.getEntry('META-INF/mods.toml');
  if (entry) {
    const raw = entry.getData().toString('utf8');
    const parsed = toml.parse(raw);
    return parsed.mods.map(mod => ({
      id: mod.modId,
      version: mod.version,
      name: mod.displayName,
      description: mod.description,
      authors: mod.authors,
      dependencies: mod.dependencies || {},
    }));
  }

  // 3. Fabric JSON
  entry = zip.getEntry('fabric.mod.json');
  if (entry) {
    const json = JSON.parse(entry.getData().toString('utf8'));
    return [{
      id: json.id,
      version: json.version,
      name: (json.metadata && json.metadata.name) || json.id,
      description: json.metadata && json.metadata.description,
      authors: (json.metadata && json.metadata.contributors || []).map(c => c.name),
      dependencies: json.depends || {},
    }];
  }

  // 4. Manifest fallback
  entry = zip.getEntry('META-INF/MANIFEST.MF');
  if (entry) {
    const text = entry.getData().toString('utf8');
    const props = {};
    text.split(/\r?\n/).forEach(line => {
      const [k, v] = line.split(': ');
      if (k && v) props[k.trim()] = v.trim();
    });
    return [{
      id: props['Implementation-Title'] || path.basename(jarPath),
      version: props['Implementation-Version'] || 'unknown',
    }];
  }

  // No metadata found
  return [];
}

app.whenReady().then(() => {
  // Launch handler (existing)
  ipcMain.on('launch', (event, arg) => {
    let consoleWin = createConsole();
    const proc = spawn('node', [mainIndex, '--ui']);

    proc.stdout.on('data', data => {
      consoleWin.webContents.send('msg', data.toString());
      console.log(`stdout: ${data}`);
    });

    proc.stderr.on('data', data => {
      consoleWin.webContents.send('error', data.toString());
      console.error(`stderr: ${data}`);
    });

    proc.on('close', code => {
      console.log(`child process exited with code ${code}`);
    });

    proc.on('error', error => {
      console.error(`Error: ${error}`);
    });

    proc.on('exit', code => {
      console.log(`Process exited with code: ${code}`);
      event.reply('process-exit', code);
      consoleWin.close();
      consoleWin = null;
    });
  });

  // Download-to-mods-folder handler (existing)
  ipcMain.on('downloadToModsFolder', (event, url) => {
    fetch(url)
      .then(response => {
        if (!response.ok) throw new Error('Network response was not ok');
        return response.arrayBuffer();
      })
      .then(buffer => {
        const modsFolder = path.join(__dirname, '.minecraft', 'mods');
        if (!fs.existsSync(modsFolder)) fs.mkdirSync(modsFolder);
        const filePath = path.join(modsFolder, decodeURIComponent(path.basename(url)));
        fs.writeFileSync(filePath, Buffer.from(buffer));
        event.reply('download-complete', filePath);
      })
      .catch(err => {
        event.reply('download-error', err.message);
      });
  });

  // List raw mod files (existing)
  ipcMain.handle('getInstalledMods', () => {
    const modsFolder = path.join(__dirname, '.minecraft', 'mods');
    if (!fs.existsSync(path.join(__dirname, '.minecraft'))) if (!fs.existsSync(modsFolder)) fs.mkdirSync(modsFolder);
    return fs.readdirSync(modsFolder)
             .filter(f => f.endsWith('.jar') || f.endsWith('.zip'))
             .map(f => path.join(modsFolder, f));
  });

  // New: List mods with parsed metadata
  ipcMain.handle('getModsWithMetadata', () => {
    try {
      const modsFolder = path.join(__dirname, '.minecraft', 'mods');
    if (!fs.existsSync(path.join(__dirname, '.minecraft'))) if (!fs.existsSync(modsFolder)) fs.mkdirSync(modsFolder, { recursive: true });

    return fs.readdirSync(modsFolder)
      .filter(f => f.endsWith('.jar') || f.endsWith('.zip'))
      .map(filename => {
        const fullPath = path.join(modsFolder, filename);
        const metadata = getModMetadata(fullPath);
        return { path: fullPath, metadata };
      });
    } catch (error) {
      console.error('Error reading mods folder:', error);
      fs.mkdirSync(path.join(__dirname, '.minecraft', 'mods'), { recursive: true });
      return [];
    }
  });

  ipcMain.on('deleteFromModsFolder', (event, path) => {
    fs.rmSync(path, { force: true });
  });

  ipcMain.handle('getConfig', async (event, clientOrLauncher) => {
    const configPath = path.join(__dirname, `${clientOrLauncher == "client" ? "config" : "launcher_config"}.json`);
    if (!fs.existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    const configData = fs.readFileSync(configPath);
    console.log(`Config data: ${configData}`);
    return JSON.parse(configData);
  });

  ipcMain.handle('saveConfig', async (event, clientOrLauncher, config) => {
    const configPath = path.join(__dirname, `${clientOrLauncher == "client" ? "config" : "launcher_config"}.json`);
    fs.writeFileSync(configPath, config);
  });

  // Open main window
  createWindow();
});

// Quit on all windows closed (optional, standard behavior)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
