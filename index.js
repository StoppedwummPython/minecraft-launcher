/* eslint-disable no-console, no-await-in-loop, camelcase */
// NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import fetch from 'node-fetch';
import AdmZip from 'adm-zip';
import cliProgress from 'cli-progress';
import { downloadJava } from './java.js';
import launcherConfig from "./launcher_config.json" with { type: 'json' };
import { replaceText } from './replacer.js';
let defaultVersion = 'neoforge-21.1.162.json'
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let patchedLauncherConfig = {};
for (const [key, value] of Object.entries(launcherConfig)) {
    patchedLauncherConfig[key] = await replaceText(value, {
        ':thisdir:': __dirname
    })
}
console.log(`Launcher config: ${JSON.stringify(patchedLauncherConfig, null, 2)}`);

// --- Configuration ---
// Main target version manifest filename
const TARGET_VERSION_MANIFEST_FILENAME = launcherConfig.version || defaultVersion; // <--- CHANGE THIS to the modded manifest file
let cfg
try {
    cfg = JSON.parse(await fs.readFile(path.join(__dirname, 'config.json'), 'utf-8'));
} catch (e) {
    cfg = {}
}

// Auth details (replace placeholders)
const AUTH_PLAYER_NAME = "auth_player_name" in cfg && cfg.auth_player_name !== "" ? cfg.auth_player_name : 'Player'

const AUTH_UUID = "auth_uuid" in cfg && cfg.auth_uuid !== "" ? cfg.auth_uuid : '00000000-0000-0000-0000-000000000000';
const AUTH_ACCESS_TOKEN = '00000000000000000000000000000000';
const AUTH_XUID = '0';
const USER_TYPE = 'msa';

// --- Directories ---
const MINECRAFT_DIR = path.join(patchedLauncherConfig.basepath, patchedLauncherConfig.path);
const VERSIONS_DIR = path.join(MINECRAFT_DIR, 'versions');
const LIBRARIES_DIR = path.join(MINECRAFT_DIR, 'libraries');
const ASSETS_DIR = path.join(MINECRAFT_DIR, 'assets');
const ASSET_INDEXES_DIR = path.join(ASSETS_DIR, 'indexes');
const ASSET_OBJECTS_DIR = path.join(ASSETS_DIR, 'objects');
const LAUNCHER_PROFILES_PATH = path.join(MINECRAFT_DIR, 'launcher_profiles.json');
const CLIENT_STORAGE_PATH = path.join(MINECRAFT_DIR, 'client_storage.json');
const BACKUP_PATH = path.join(__dirname, '.minecraft_autobackup'); // Backup path (if needed)
const javaInstallDir = path.join(__dirname, 'java-runtime');
let CLIENT_STORAGE

// --- Helper Functions --- (Mostly unchanged, added error details)
// ... (getFileSha1, fileExists, downloadFile, extractNatives, getOSName, getArchName, checkRule, checkLibraryRules, ensureLauncherProfiles) ...

/**
 * Calculates the SHA1 hash of a file.
 * @param {string} filePath - Path to the file.
 * @returns {Promise<string>} The SHA1 hash.
 */
async function getFileSha1(filePath) {
  const fileBuffer = await fs.readFile(filePath);
  const hashSum = crypto.createHash('sha1');
  hashSum.update(fileBuffer);
  return hashSum.digest('hex');
}

/**
 * Checks if a file exists.
 * @param {string} filePath - Path to the file.
 * @returns {Promise<boolean>} True if the file exists, false otherwise.
 */
async function fileExists(filePath) {
  try {
    await fs.access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Downloads a file from a URL, ensuring the directory exists, and verifies SHA1 hash.
 * Now quieter, relies on caller for progress updates.
 * @param {string} url - The URL to download from.
 * @param {string} destPath - The destination file path.
 * @param {string | null} expectedSha1 - The expected SHA1 hash for verification (or null).
 * @param {boolean} forceDownload - If true, download even if file exists (but hash check still happens if expectedSha1 is provided).
 * @returns {Promise<boolean>} True if a download occurred, false otherwise.
 */
async function downloadFile(url, destPath, expectedSha1, forceDownload = false) {
  const dir = path.dirname(destPath);
  await fs.mkdir(dir, { recursive: true });

  let needsDownload = forceDownload;
  const exists = await fileExists(destPath);

  if (exists && !forceDownload) {
    if (expectedSha1) {
      try {
        const currentSha1 = await getFileSha1(destPath);
        if (currentSha1 === expectedSha1) {
          return false; // No download needed
        }
        needsDownload = true;
      } catch (hashError) {
          console.warn(`\nWarning: Could not hash existing file ${destPath}. Redownloading. Error: ${hashError.message}`)
          needsDownload = true; // Couldn't verify, better redownload
      }
    } else {
      return false; // No download needed
    }
  } else if (!exists) {
      needsDownload = true;
  }

  if (!needsDownload) return false;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      try { await fs.unlink(destPath); } catch { /* ignore */ }
      throw new Error(`Failed to download ${url}: ${response.statusText} (Status: ${response.status})`);
    }
    const fileStream = await fs.open(destPath, 'w');
    if (!response.body) {
        await fileStream.close();
        throw new Error(`Response body is null for ${url}`);
    }

    await new Promise((resolve, reject) => {
        const writeStream = fileStream.createWriteStream();
        response.body.pipe(writeStream);
        response.body.on('error', (err) => reject(err));
        writeStream.on('finish', resolve);
        writeStream.on('error', (err) => reject(err));
    }).finally(() => {
        return fileStream.close().catch(closeErr => console.error(`Error closing file handle for ${destPath}: ${closeErr.message}`));
    });

    if (expectedSha1) {
      const downloadedSha1 = await getFileSha1(destPath);
      if (downloadedSha1 !== expectedSha1) {
        throw new Error(`SHA1 mismatch for ${path.basename(destPath)}. Expected ${expectedSha1}, got ${downloadedSha1}`);
      }
    }
    return true; // Download occurred
  } catch (error) {
    console.error(`\nError downloading ${url}:`, error);
    try {
      if (await fileExists(destPath)) {
          await fs.unlink(destPath);
      }
    } catch (unlinkError) { /* Ignore */ }
    throw error; // Re-throw to stop the process
  }
}


/**
 * Extracts native libraries from a JAR file. Quieter.
 * @param {string} jarPath - Path to the JAR file containing natives.
 * @param {string} extractToDir - Directory to extract natives into.
 * @returns {Promise<void>}
 */
async function extractNatives(jarPath, extractToDir) {
  await fs.mkdir(extractToDir, { recursive: true });
  try {
    const zip = new AdmZip(jarPath);
    const entries = zip.getEntries().filter(entry => !entry.entryName.startsWith('META-INF/'));
    entries.forEach((zipEntry) => {
      try {
         zip.extractEntryTo(zipEntry.entryName, extractToDir, false, true);
      } catch(extractError) {
         console.warn(`\nWarning: Could not extract ${zipEntry.entryName} from ${path.basename(jarPath)}. Error: ${extractError.message}`);
      }
    });
  } catch (error) {
    console.error(`\nFailed to read or process zip file ${jarPath}:`, error);
    throw error;
  }
}

/**
 * Gets the current OS name in the format used by Minecraft manifests.
 * @returns {'windows' | 'osx' | 'linux'}
 */
function getOSName() {
  switch (process.platform) {
    case 'win32': return 'windows';
    case 'darwin': return 'osx';
    case 'linux': return 'linux';
    default: throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

/**
 * Gets the current architecture name in the format used by Minecraft manifests.
 * @returns {'x86' | 'x64' | 'arm64' | 'arm32'}
 */
function getArchName() {
    switch (process.arch) {
        case 'x64': return 'x64';
        case 'ia32': return 'x86';
        case 'arm64': return 'arm64';
        case 'arm': return 'arm32';
        default: throw new Error(`Unsupported architecture: ${process.arch}`);
    }
}

/**
 * Checks if a library rule allows the library for the current OS/arch/features.
 * @param {object | undefined} rule - The rule object from the manifest.
 * @returns {boolean} True if the rule allows, false otherwise.
 */
function checkRule(rule) {
  if (!rule || !rule.action) {
    return true; // Default to allow if no rule specified
  }

  let applies = true; // Does the condition (OS, features) match?

  // Check OS condition
  if (rule.os) {
    const osName = getOSName();
    const archName = getArchName();
    if (rule.os.name && rule.os.name !== osName) applies = false;
    if (applies && rule.os.arch && rule.os.arch !== archName) applies = false;
    // Version check omitted for simplicity
  }

  // Check features condition (basic example)
  if (applies && rule.features) {
      if (rule.features.is_demo_user && ("demo" in cfg && cfg.demo)) applies = true; // Replace false with actual check
      else if (rule.features.has_custom_resolution && true) applies = true; // Replace true with actual check
      // Add other feature checks here...
      else applies = false; // Feature condition not met
  }


  // Evaluate action based on whether the condition applies
  if (rule.action === 'allow') {
    return applies; // Allow if condition applies
  } else if (rule.action === 'disallow') {
    return !applies; // Allow if condition *doesn't* apply (i.e., don't disallow)
  }

  return true; // Default allow for unknown actions or conditions
}


/**
 * Checks if an item (library or argument) should be included based on its rules array.
 * @param {Array<object> | undefined} rules - The rules array from the item object.
 * @returns {boolean} True if the item should be included.
 */
function checkItemRules(rules) {
  if (!rules || rules.length === 0) {
    return true; // No rules, always include
  }

  // Default action is allow. If any rule results in disallow, return false.
  let allowed = true; // Assume allowed unless a rule forbids it
  for(const rule of rules) {
      if (!checkRule(rule)) { // Check if the rule itself permits inclusion
          allowed = false;
          break;
      }
  }
  return allowed;
}

/**
 * Ensures launcher_profiles.json exists and contains basic info.
 * @param {string} currentVersionId - The version ID being launched (e.g., "neoforge-21.1.162").
 */
async function ensureLauncherProfiles(currentVersionId) {
    console.log('Checking launcher profiles...');
    const profileName = `custom-${currentVersionId}`; // Use target ID
    const authProfileKey = AUTH_UUID.replace(/-/g, '');
    const accountKey = `account-${authProfileKey}`;

    // Basic structure, OVERWRITES existing file for simplicity
    const profilesData = {
        profiles: {
            [profileName]: {
                lastVersionId: currentVersionId,
                name: profileName,
                type: "custom"
            }
        },
        authenticationDatabase: {
            [accountKey]: {
                accessToken: AUTH_ACCESS_TOKEN,
                profiles: {
                    [authProfileKey]: {
                        displayName: AUTH_PLAYER_NAME,
                        playerUUID: AUTH_UUID,
                        userId: AUTH_XUID
                    }
                },
                username: AUTH_PLAYER_NAME,
            }
        },
        settings: {},
        selectedUser: {
            account: accountKey,
            profile: authProfileKey
        },
        version: 4
    };

    try {
        await fs.writeFile(LAUNCHER_PROFILES_PATH, JSON.stringify(profilesData, null, 2));
        console.log(`Created/updated ${LAUNCHER_PROFILES_PATH}`);
    } catch (error) {
        console.error(`Failed to write ${LAUNCHER_PROFILES_PATH}: ${error}`);
        throw new Error(`Could not write launcher profiles file.`);
    }
}


// --- Manifest Loading and Merging ---

/**
 * Loads a JSON manifest file.
 * @param {string} filename - The name of the JSON file in the script's directory.
 * @returns {Promise<object>} The parsed JSON content.
 */
async function loadManifest(filename) {
    const filePath = path.join(__dirname, filename);
    console.log(`Loading manifest: ${filename}`);
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        console.error(`Failed to load or parse manifest ${filename}: ${error}`);
        throw new Error(`Manifest file not found or invalid: ${filename}`);
    }
}

/**
 * Merges two version manifests (target inheriting from base).
 * @param {object} targetManifest - The modded manifest (e.g., NeoForge).
 * @param {object} baseManifest - The base vanilla manifest.
 * @returns {object} A new object representing the merged manifest data.
 */
function mergeManifests(targetManifest, baseManifest) {
    console.log(`Merging manifests: ${targetManifest.id} inheriting from ${baseManifest.id}`);

    // Combine libraries: Use a Map to handle potential duplicates, target overrides base
    const combinedLibrariesMap = new Map();
    (baseManifest.libraries || []).forEach(lib => combinedLibrariesMap.set(lib.name, lib));
    (targetManifest.libraries || []).forEach(lib => combinedLibrariesMap.set(lib.name, lib)); // Overwrites if name exists

    // Combine arguments: Append target arguments to base arguments
    const combinedArguments = {
        game: [
            ...(baseManifest.arguments?.game || []),
            ...(targetManifest.arguments?.game || [])
        ],
        jvm: [
            ...(baseManifest.arguments?.jvm || []),
            ...(targetManifest.arguments?.jvm || [])
        ]
    };

    // Construct the merged manifest
    const merged = {
        id: targetManifest.id, // Use target ID
        time: targetManifest.time,
        releaseTime: targetManifest.releaseTime,
        type: targetManifest.type,
        mainClass: targetManifest.mainClass, // Target mainClass overrides base
        assetIndex: targetManifest.assetIndex || baseManifest.assetIndex, // Prefer target's asset index
        assets: targetManifest.assets || baseManifest.assets,
        downloads: baseManifest.downloads, // Use base downloads (for client.jar URL etc)
                                            // Target might specify patches later, but base JAR source is vanilla
        javaVersion: targetManifest.javaVersion || baseManifest.javaVersion, // Prefer target
        libraries: Array.from(combinedLibrariesMap.values()), // Convert map back to array
        arguments: combinedArguments, // Use combined arguments
        logging: targetManifest.logging || baseManifest.logging, // Prefer target
        complianceLevel: targetManifest.complianceLevel || baseManifest.complianceLevel,
        minimumLauncherVersion: targetManifest.minimumLauncherVersion || baseManifest.minimumLauncherVersion
        // Note: `inheritsFrom` is intentionally omitted in the merged result
    };

    return merged;
}


// --- Main Execution ---
async function main() {
    // 1. Load Target Manifest
    const targetManifest = await loadManifest(TARGET_VERSION_MANIFEST_FILENAME);
    const targetVersionId = targetManifest.id;

    // 2. Load Base Manifest if needed
    let finalManifest = targetManifest; // Start with the target
    if (targetManifest.inheritsFrom) {
        const baseManifestFilename = `${targetManifest.inheritsFrom}.json`;
        try {
            const baseManifest = await loadManifest(baseManifestFilename);
            // 3. Merge Manifests
            finalManifest = mergeManifests(targetManifest, baseManifest);
        } catch (error) {
            console.error(`Could not load or merge base manifest specified in ${TARGET_VERSION_MANIFEST_FILENAME}: ${error.message}`);
            process.exit(1); // Exit if base manifest is missing/invalid
        }
    } else {
        console.log(`Manifest ${targetVersionId} does not inherit from another version.`);
    }

    // --- Use finalManifest for all subsequent steps ---
    const versionId = finalManifest.id; // This is the target ID (e.g., "neoforge-21.1.162")
    const VERSION_DIR = path.join(VERSIONS_DIR, versionId); // Use target ID for directory
    const NATIVES_DIR = path.join(VERSION_DIR, `${versionId}-natives`); // Use target ID for natives

    console.log(`Preparing Minecraft ${versionId}...`);
    const osName = getOSName();
    const archName = getArchName();
    console.log(`Detected OS: ${osName}, Arch: ${archName}`);

    // 4. Ensure Directories and Launcher Profiles
    console.log(`Ensuring directory exists: ${MINECRAFT_DIR}`);
    await fs.mkdir(MINECRAFT_DIR, { recursive: true });
    await fs.mkdir(VERSIONS_DIR, { recursive: true });
    await fs.mkdir(LIBRARIES_DIR, { recursive: true });
    await fs.mkdir(ASSETS_DIR, { recursive: true });

    await ensureLauncherProfiles(versionId); // Create profiles using target ID

    console.log(`Ensuring directory exists: ${VERSION_DIR}`);
    await fs.mkdir(VERSION_DIR, { recursive: true });
    await fs.mkdir(NATIVES_DIR, { recursive: true });
    await fs.mkdir(ASSET_INDEXES_DIR, { recursive: true });
    await fs.mkdir(ASSET_OBJECTS_DIR, { recursive: true });

    // 5. Copy *Target* Version Manifest JSON to Version Directory
    const targetManifestSourcePath = path.join(__dirname, TARGET_VERSION_MANIFEST_FILENAME);
    const destManifestPath = path.join(VERSION_DIR, `${versionId}.json`); // Save as targetID.json
    try {
        console.log(`Copying ${TARGET_VERSION_MANIFEST_FILENAME} to ${destManifestPath}`);
        await fs.copyFile(targetManifestSourcePath, destManifestPath);
    } catch (error) {
        console.error(`Failed to copy target version manifest: ${error}`);
        throw new Error(`Could not copy version manifest file: ${targetManifestSourcePath}`);
    }

    // 6. Download Client JAR (using base manifest download info, saving as target ID)
    console.log('Checking client JAR...');
    // finalManifest.downloads comes from the base manifest in merge logic
    if (!finalManifest.downloads?.client) {
        throw new Error(`Merged manifest for ${versionId} is missing client download information.`);
    }
    const clientInfo = finalManifest.downloads.client;
    const clientJarPath = path.join(VERSION_DIR, `${versionId}.jar`); // Save as targetID.jar
    await downloadFile(clientInfo.url, clientJarPath, clientInfo.sha1);

    // 7. Download Libraries (using merged library list)
    console.log('Checking libraries...');
    const librariesToProcess = [];
    const classpathEntries = [clientJarPath]; // Start classpath with the client JAR
    const nativeLibraryPaths = [];

    // Process the merged library list
    for (const lib of finalManifest.libraries) {
        // Apply rules check from the library entry itself
        if (!checkItemRules(lib.rules)) { // Using checkItemRules for libraries too
             // console.log(`Skipping library due to rules: ${lib.name}`);
             continue;
        }

        let artifact = lib.downloads?.artifact;
        let nativeClassifier = null;

        // Check for natives specific to the current OS/Arch (less common in modern manifests)
        if (lib.natives?.[osName]) {
            nativeClassifier = lib.natives[osName].replace('${arch}', archName === 'x86' ? '32' : '64');
        }

        // Check classifiers (more common)
         if (lib.downloads?.classifiers) {
            const potentialNativeKeys = [
                `natives-${osName}-${archName}`,
                `natives-${osName}`,
            ];
            for (const key of potentialNativeKeys) {
                if (lib.downloads.classifiers[key]) {
                    nativeClassifier = key;
                    break;
                }
            }
            // Handle specific natives like 'natives-windows-x86' ONLY if a classifier wasn't found above
            if (!nativeClassifier) {
                const specificNativeKey = lib.name?.split(':').pop(); // Use optional chaining
                 if (lib.downloads.classifiers[specificNativeKey] && specificNativeKey?.startsWith('natives-')) {
                     const parts = specificNativeKey.split('-');
                     if (parts.length >= 2 && parts[1] === osName) {
                         if (parts.length === 2 || (parts.length >= 3 && parts[2] === archName)) {
                             nativeClassifier = specificNativeKey;
                         }
                     }
                 }
            }
        }

        // Add main artifact if it exists
        if (artifact?.path && artifact?.url) {
            librariesToProcess.push({
                name: lib.name,
                url: artifact.url,
                path: path.join(LIBRARIES_DIR, artifact.path),
                sha1: artifact.sha1,
                isNative: false,
            });
        }

        // Add native artifact if it exists
        const nativeInfo = lib.downloads?.classifiers?.[nativeClassifier];
        if (nativeInfo?.path && nativeInfo?.url) {
            librariesToProcess.push({
                name: `${lib.name}:${nativeClassifier}`,
                url: nativeInfo.url,
                path: path.join(LIBRARIES_DIR, nativeInfo.path),
                sha1: nativeInfo.sha1,
                isNative: true,
            });
        }
    }

    // Download phase with progress bar
    const libProgressBar = new cliProgress.SingleBar({ /* ... format ... */ }, cliProgress.Presets.shades_classic);
    console.log(`Processing ${librariesToProcess.length} library files...`);
    libProgressBar.start(librariesToProcess.length, 0, { filename: "Starting..." });

    for (const lib of librariesToProcess) {
        const filename = path.basename(lib.path);
        try {
            await downloadFile(lib.url, lib.path, lib.sha1);
            if (!lib.isNative) {
                if (!classpathEntries.includes(lib.path)) {
                    classpathEntries.push(lib.path);
                }
            } else {
                nativeLibraryPaths.push(lib.path);
            }
        } catch(error) {
            libProgressBar.stop();
            console.error(`\nFailed to download library: ${filename}`);
            throw error;
        }
        libProgressBar.increment(1, { filename });
    }
    libProgressBar.stop();
    console.log('Library check complete.');

    // 8. Extract Natives
    console.log('\nExtracting native libraries...');
    // ... (native extraction logic remains the same, using NATIVES_DIR based on target ID) ...
    try {
        if (await fileExists(NATIVES_DIR)) {
            await fs.rm(NATIVES_DIR, { recursive: true, force: true });
        }
        await fs.mkdir(NATIVES_DIR, { recursive: true });
    } catch (err) {
        console.warn(`Could not clear/recreate natives directory: ${err.message}`);
    }

    if (nativeLibraryPaths.length > 0) {
        const nativeProgressBar = new cliProgress.SingleBar({/* ... format ... */}, cliProgress.Presets.shades_classic);
        nativeProgressBar.start(nativeLibraryPaths.length, 0, { filename: "Starting..." });
        for (const nativeJarPath of nativeLibraryPaths) {
            const filename = path.basename(nativeJarPath);
            try {
                await extractNatives(nativeJarPath, NATIVES_DIR);
            } catch (error) {
                nativeProgressBar.stop();
                console.error(`\nFailed to extract natives from: ${filename}`);
                throw error;
            }
            nativeProgressBar.increment(1, { filename });
        }
        nativeProgressBar.stop();
    } else {
        console.log("No native libraries to extract for this platform.");
    }
    console.log('Native extraction complete.');

    // 9. Download Assets (using merged asset index info)
    console.log('\nChecking assets...');
    if (!finalManifest.assetIndex) {
        throw new Error(`Merged manifest for ${versionId} is missing asset index information.`);
    }
    const assetIndexInfo = finalManifest.assetIndex;
    const assetIndexFileName = `${assetIndexInfo.id}.json`;
    const assetIndexPath = path.join(ASSET_INDEXES_DIR, assetIndexFileName);
    await downloadFile(assetIndexInfo.url, assetIndexPath, assetIndexInfo.sha1);

    const assetIndexContent = JSON.parse(await fs.readFile(assetIndexPath, 'utf-8'));
    // ... (rest of asset download logic remains the same) ...
    const assetObjects = assetIndexContent.objects;
    const totalAssets = Object.keys(assetObjects).length;
    const assetProgressBar = new cliProgress.SingleBar({/* ... format ... */}, cliProgress.Presets.shades_classic);
    console.log(`Checking ${totalAssets} asset files...`);
    assetProgressBar.start(totalAssets, 0, { filehash: "Starting..." });
    for (const assetKey in assetObjects) {
        const asset = assetObjects[assetKey];
        const hash = asset.hash;
        const subDir = hash.substring(0, 2);
        const assetSubDir = path.join(ASSET_OBJECTS_DIR, subDir);
        const assetFilePath = path.join(assetSubDir, hash);
        const assetUrl = `https://resources.download.minecraft.net/${subDir}/${hash}`;
        try {
            await downloadFile(assetUrl, assetFilePath, hash);
        } catch (error) {
            assetProgressBar.stop();
            console.error(`\nFailed to download asset: ${hash}`);
            throw error;
        }
        assetProgressBar.increment(1, { filehash: hash });
    }
    assetProgressBar.stop();
    console.log(`Asset check complete.`);
    const jE = await downloadJava({
        version: finalManifest.javaVersion.majorVersion, // Specify the Java version you need
        destinationDir: javaInstallDir,
        imageType: 'jdk', // Or 'jre' if you only need the runtime
      });

    console.log("Loading client storage...");
    let storageExist
    try {
        await fs.access(CLIENT_STORAGE_PATH);
        storageExist = true
    } catch {
        storageExist = false
    }
    if (storageExist) {
        try {
            const content = await fs.readFile(CLIENT_STORAGE_PATH, 'utf-8');
            CLIENT_STORAGE = JSON.parse(content);
        } catch (error) {
            console.error(`Failed to load ${CLIENT_STORAGE_PATH}: ${error}`);
            throw new Error(`Could not load client storage file.`);
        }
    } else {
        CLIENT_STORAGE = {
            setupNeoForge: false
        };
        try {
            await fs.writeFile(CLIENT_STORAGE_PATH, JSON.stringify(CLIENT_STORAGE, null, 2));
        } catch (error) {
            console.error(`Failed to write ${CLIENT_STORAGE_PATH}: ${error}`);
            throw new Error(`Could not write client storage file.`);
        }
    }

    if (typeof CLIENT_STORAGE.setupNeoForge === 'boolean') {
        // Migrate from boolean to array
        CLIENT_STORAGE.setupNeoForge = []
    }

    if (String(versionId).startsWith("neoforge-") && !CLIENT_STORAGE.setupNeoForge.includes(versionId)) {
        // Run subprocess to setup neoforge
        console.log(`Setting up NeoForge...`);
        const setupNeoForgeScript = path.join(__dirname, 'neoinstaller.jar');
        const setupNeoForgeCommand = `${jE} -jar ${setupNeoForgeScript} --install-client .minecraft`;
        const setupNeoForgeProcess = spawn(setupNeoForgeCommand, { shell: true });
        setupNeoForgeProcess.stdout.on('data', (data) => {
            console.log(data.toString());
        });
        setupNeoForgeProcess.stderr.on('data', (data) => {
            console.error(data.toString());
        });
        await new Promise((resolve, reject) => {
            setupNeoForgeProcess.on('exit', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`NeoForge setup failed with exit code ${code}`));
                }
            });
        });
        CLIENT_STORAGE.setupNeoForge.push(versionId);
        await fs.writeFile(CLIENT_STORAGE_PATH, JSON.stringify(CLIENT_STORAGE, null, 2));
    }
    // 10. Construct Launch Command (using merged arguments and target mainClass)
    console.log('\nConstructing launch command...');
    const classpath = classpathEntries.join(path.delimiter);

    // --- Argument Placeholder Replacements ---
    const replacements = {
        '${natives_directory}': NATIVES_DIR,
        '${library_directory}': LIBRARIES_DIR, // Added for Forge/NeoForge
        '${classpath_separator}': path.delimiter, // Added for Forge/NeoForge
        '${launcher_name}': 'CustomLauncher',
        '${launcher_version}': '1.0',
        '${classpath}': classpath, // Classpath uses merged libs
        '${auth_player_name}': AUTH_PLAYER_NAME,
        '${version_name}': versionId, // Use target version ID
        '${game_directory}': MINECRAFT_DIR,
        '${assets_root}': ASSETS_DIR,
        '${assets_index_name}': finalManifest.assets, // Use merged assets ID
        '${auth_uuid}': AUTH_UUID,
        '${auth_access_token}': AUTH_ACCESS_TOKEN,
        '${clientid}': 'N/A',
        '${auth_xuid}': AUTH_XUID,
        '${user_type}': USER_TYPE,
        '${version_type}': finalManifest.type, // Use target type
        '${resolution_width}': '854',
        '${resolution_height}': '480',
    };

    const replacePlaceholders = (arg) => {
        let replacedArg = arg;
        for (const key in replacements) {
            replacedArg = replacedArg.replaceAll(key, replacements[key]);
        }
        return replacedArg;
    };

    // Process combined JVM Arguments
    const jvmArgs = [];
    (finalManifest.arguments.jvm || []).forEach(arg => {
        if (typeof arg === 'string') {
            jvmArgs.push(replacePlaceholders(arg));
        } else if (typeof arg === 'object' && checkItemRules(arg.rules)) { // Use checkItemRules
            const value = arg.value;
            if (Array.isArray(value)) {
                value.forEach(val => jvmArgs.push(replacePlaceholders(val)));
            } else if (typeof value === 'string') {
                jvmArgs.push(replacePlaceholders(value));
            }
        }
    });

    // Process combined Game Arguments
    const gameArgs = [];
    (finalManifest.arguments.game || []).forEach(arg => {
        if (typeof arg === 'string') {
            gameArgs.push(replacePlaceholders(arg));
        } else if (typeof arg === 'object' && checkItemRules(arg.rules)) { // Use checkItemRules
             const value = arg.value;
            if (Array.isArray(value)) {
                value.forEach(val => gameArgs.push(replacePlaceholders(val)));
            } else if (typeof value === 'string') {
                gameArgs.push(replacePlaceholders(value));
            }
        }
    });

    // 11. Launch Minecraft
    console.log(jE)
    const javaExecutable = jE; // Assumes Java 21 is in PATH (check finalManifest.javaVersion if needed)
    const finalArgs = [
        ...jvmArgs,
        finalManifest.mainClass, // Use target mainClass
        ...gameArgs,
    ];

    console.log('Attempting to launch Minecraft...');
    // console.log(`DEBUG: ${javaExecutable} ${finalArgs.join(' ')}`); // Optional debug log

    const mcProcess = spawn(javaExecutable, finalArgs, {
        cwd: MINECRAFT_DIR,
        stdio: 'inherit',
    });
    // ... (spawn event handlers remain the same) ...
      mcProcess.on('spawn', () => {
        console.log('Minecraft process spawned successfully.');
      });

      mcProcess.on('error', (err) => {
        console.error('Failed to start Minecraft process:', err);
         if (err.message.includes('ENOENT')) {
            console.error(`\nError: '${javaExecutable}' command not found.`);
            // Check required Java version
            const requiredJava = finalManifest.javaVersion?.majorVersion;
            if (requiredJava) {
                 console.error(`NeoForge version ${versionId} requires Java ${requiredJava}.`);
            }
            console.error('Please ensure the correct Java Development Kit (JDK) is installed and added to your system\'s PATH.');
        }
      });

      mcProcess.on('close', async (code) => {
        if ("backup" in cfg && cfg.backup) {
            console.log(`Minecraft process exited with code ${code}, copying backup...`);
        } else {
            console.log(`Minecraft process exited with code ${code}.`);
            return; // No backup needed
        }
        try {
            await fs.cp(MINECRAFT_DIR, BACKUP_PATH, { recursive: true, force: true })
            console.log(`Backup created at ${BACKUP_PATH}, zipping...`);
            await new Promise((resolve, reject) => {
                const zip = new AdmZip();
                zip.addLocalFolder(BACKUP_PATH);
                zip.writeZip(BACKUP_PATH + '.zip', (err) => {
                    if (err) {
                        console.error(`Failed to create zip backup: ${err}`);
                        reject(err);
                    } else {
                        console.log(`Backup zip created at ${BACKUP_PATH}.zip`);
                        resolve();
                    }
                });
            })
            // removing old backup
            await fs.rm(BACKUP_PATH, { recursive: true, force: true });

        } catch (error) {
            console.error(`Failed to create backup: ${error}`);
        }
            
      });


} // End of main function
// --ui adds fix to the launcher (when the ui launches, it returns ui_index.cjs as the entry point script, which will trigger module logic, which is now fixed)
const entryPointScript = process.argv[1].split(path.sep).pop();
if (entryPointScript === __filename || entryPointScript === __dirname.split(path.sep).pop() || (process.argv.length == 3 && process.argv[2] == "--ui")) {
    main().catch(error => {
        console.error("\n--- An error occurred during setup or launch ---");
        console.error(error);
        process.exit(1);
    });
}

export default {
    downloadFile,
    extractNatives,
    getOSName,
    getArchName,
    checkRule,
    checkItemRules,
    ensureLauncherProfiles,
    loadManifest,
    mergeManifests,
    main
}