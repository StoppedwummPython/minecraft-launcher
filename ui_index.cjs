// main.js

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const java = require("./java.js")

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

fs.mkdirSync(path.join(__dirname, '.minecraft', 'modpacks'), { recursive: true });

if (!fs.existsSync(path.join(__dirname, '.minecraft', 'modpacks', 'modpacks.json'))) {
  fs.writeFileSync(path.join(__dirname, '.minecraft', 'modpacks', 'modpacks.json'), JSON.stringify([]));
}

ipcMain.handle('getModpacks', async () => {
  const modpacksPath = path.join(__dirname, '.minecraft', 'modpacks');
  if (!fs.existsSync(modpacksPath)) {
    fs.mkdirSync(modpacksPath, { recursive: true });
  }
  return JSON.parse(fs.readFileSync(path.join(modpacksPath, 'modpacks.json'), 'utf8') || '[]');
});

ipcMain.handle('createModpack', async (event, modpack) => {
  const modpacksPath = path.join(__dirname, '.minecraft', 'modpacks');
  if (!fs.existsSync(modpacksPath)) {
    fs.mkdirSync(modpacksPath, { recursive: true });
  }

  const modpacksFile = path.join(modpacksPath, 'modpacks.json');
  let modpacks = [];

  if (fs.existsSync(modpacksFile)) {
    modpacks = JSON.parse(fs.readFileSync(modpacksFile, 'utf8') || '[]');
  }

  modpacks.push(modpack);
  fs.writeFileSync(modpacksFile, JSON.stringify(modpacks, null, 2));
  fs.mkdirSync(path.join(modpacksPath, modpack), { recursive: true });
  fs.readdirSync(path.join(__dirname, '.minecraft', 'mods')).forEach(file => {
    if (file.startsWith('.')) return; // Skip hidden files
    fs.copyFileSync(path.join(__dirname, '.minecraft', 'mods', file), path.join(modpacksPath, modpack, file));
  });
});

ipcMain.handle('getModsFromModpack', async (event, modpack) => {
  const modpacksPath = path.join(__dirname, '.minecraft', 'modpacks');
  const modpackPath = path.join(modpacksPath, modpack);

  if (!fs.existsSync(modpackPath)) {
    throw new Error(`Modpack not found: ${modpack}`);
  }

  return fs.readdirSync(modpackPath)
    .filter(f => f.endsWith('.jar') || f.endsWith('.zip'))
});

ipcMain.handle('updateModpack', async (event, modpack) => {
  const modpacksPath = path.join(__dirname, '.minecraft', 'modpacks');
  const modpackPath = path.join(modpacksPath, modpack);
  if (!fs.existsSync(modpackPath)) {
    throw new Error(`Modpack not found: ${modpack}`);
  }
  fs.rmSync(modpackPath, { recursive: true, force: true });
  fs.mkdirSync(modpackPath, { recursive: true });
  fs.readdirSync(path.join(__dirname, '.minecraft', 'mods')).forEach(file => {
    if (file.startsWith('.')) return; // Skip hidden files
    fs.copyFileSync(path.join(__dirname, '.minecraft', 'mods', file), path.join(modpackPath, file));
  });
});

ipcMain.handle("deleteModpack", async (event, modpack) => {
  const modpacksPath = path.join(__dirname, '.minecraft', 'modpacks');
  const modpackPath = path.join(modpacksPath, modpack);
  if (fs.existsSync(modpackPath)) {
    fs.rmSync(modpackPath, { recursive: true });
    // Update modpacks.json
    const modpacksFile = path.join(modpacksPath, 'modpacks.json');
    let modpacks = [];
    if (fs.existsSync(modpacksFile)) {
      modpacks = JSON.parse(fs.readFileSync(modpacksFile, 'utf8') || '[]');
    } else {
      throw new Error(`Modpacks file not found: ${modpacksFile}`);
    }
    modpacks = modpacks.filter(mp => mp !== modpack);
    fs.writeFileSync(modpacksFile, JSON.stringify(modpacks, null, 2));
  } else {
    throw new Error(`Modpack not found: ${modpack}`);
  }
});

ipcMain.handle("installModpack", async (event, modpack) => {
  const modpacksPath = path.join(__dirname, '.minecraft', 'modpacks');
  const modpackPath = path.join(modpacksPath, modpack);
  if (!fs.existsSync(modpackPath)) {
    throw new Error(`Modpack not found: ${modpack}`);
  }
  fs.rmSync(path.join(__dirname, '.minecraft', 'mods'), { recursive: true, force: true });
  fs.mkdirSync(path.join(__dirname, '.minecraft', 'mods'), { recursive: true });
  fs.readdirSync(modpackPath).forEach(file => {
    if (file.startsWith('.')) return; // Skip hidden files
    fs.copyFileSync(path.join(modpackPath, file), path.join(__dirname, '.minecraft', 'mods', file));
  });
});

ipcMain.handle('getAllVersionFiles', async () => {
  const versionsPath = path.join(__dirname)
  const versionFiles = fs.readdirSync(versionsPath)
    .filter(file => file.endsWith('.json'))
    .filter(file => file.startsWith('1.') || file.startsWith("neoforge-"))
  return versionFiles;
});

ipcMain.handle("executeNeoforgeInstaller", (event, downloadURL, version) => {
  return new Promise(async (resolve, reject) => {
    const jv = await java.downloadJava({
      version: "21",
      imageType: "jdk",
      destinationDir: path.join(__dirname, 'java-runtime')
    })

    console.log(downloadURL, jv, version);
    const installerPath = path.join(__dirname, 'neoinstaller.jar');
    const installer = await fetch(downloadURL)
    if (!installer.ok) {
      throw new Error(`Failed to download installer: ${installer.statusText}`);
    }
    // Write the installer to a file
    const installerBuffer = await installer.arrayBuffer();
    fs.writeFileSync(installerPath, Buffer.from(installerBuffer));
    // Spawn the Java process to run the installer
    const proc = spawn(`"${jv}" -jar "${installerPath}" --install-client .minecraft`, {
      shell: true
    });
    proc.stdout.on('data', data => {
      console.log(`stdout: ${data}`);
    });
    proc.stderr.on('data', data => {
      console.error(`stderr: ${data}`);
    });
    proc.on('close', async code => {
      console.log(`child process exited with code ${code}`);
      if (code === 0) {
        console.log('NeoForge installation completed successfully.');
        fs.copyFileSync(path.join(__dirname, '.minecraft', 'versions', `neoforge-${version}`, `neoforge-${version}.json`), path.join(__dirname, `neoforge-${version}.json`));
        const manifest = require(path.join(__dirname, `neoforge-${version}.json`));
        // check if inheritsFrom exists in the directory
        if (manifest.inheritsFrom) {
          const inheritsPath = path.join(__dirname, `${manifest.inheritsFrom}.json`);
          if (!fs.existsSync(inheritsPath)) {
            const url = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
            const response = await fetch(url);
            if (!response.ok) {
              throw new Error(`Failed to fetch version manifest: ${response.statusText}`);
            }
            const manifestData = await response.json();
            const versionData = manifestData.versions.find(v => v.id === manifest.inheritsFrom);
            if (!versionData) {
              throw new Error(`Version ${manifest.inheritsFrom} not found in manifest.`);
            }
            const versionJson = await fetch(versionData.url);
            if (!versionJson.ok) {
              throw new Error(`Failed to fetch version JSON: ${versionJson.statusText}`);
            }
            // write the version JSON to the file
            fs.writeFileSync(inheritsPath, await versionJson.text());
          }
        }
        resolve(code);
      } else {
        reject(new Error(`NeoForge installation failed with code ${code}`));
      }
    });
  });
});

// Quit on all windows closed (optional, standard behavior)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
