// java.js
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import axios from 'axios';
import AdmZip from 'adm-zip';
import * as tar from 'tar';

const execFilePromise = promisify(execFile);

// --- Configuration ---
const ADOPTIUM_API_BASE = 'https://api.adoptium.net/v3';
const DEFAULT_JAVA_VERSION = 17;
const DEFAULT_IMAGE_TYPE = 'jdk';

// --- Helper Functions ---

/**
 * Executes the java binary to determine its major version.
 * @param {string} javaPath Path to the executable
 * @returns {Promise<number|null>} Major version number
 */
async function getJavaMajorVersion(javaPath) {
  try {
    // Java outputs version info to stderr
    const { stderr } = await execFilePromise(javaPath, ['-version']);
    
    // Regex matches "21.0.1" or "1.8.0_..."
    const versionMatch = stderr.match(/(?:java|openjdk) version "([^"]+)"/);
    if (!versionMatch) return null;

    const fullVersion = versionMatch[1];
    const parts = fullVersion.split('.');
    let major = parseInt(parts[0]);

    // Handle legacy versioning: 1.8.x -> 8
    if (major === 1 && parts[1]) {
      major = parseInt(parts[1]);
    }
    return major;
  } catch (error) {
    console.error(`Could not determine Java version at ${javaPath}: ${error.message}`);
    return null;
  }
}

/**
 * Maps Node.js os.platform() and os.arch() to Adoptium API values.
 */
function getApiOsArch() {
  const platform = os.platform();
  const arch = os.arch();
  let apiOs;
  let apiArch;

  switch (platform) {
    case 'win32': apiOs = 'windows'; break;
    case 'darwin': apiOs = 'mac'; break;
    case 'linux': apiOs = 'linux'; break;
    default: return null;
  }

  switch (arch) {
    case 'x64': apiArch = 'x64'; break;
    case 'arm64': apiArch = 'aarch64'; break;
    default: return null;
  }

  return { os: apiOs, arch: apiArch };
}

/**
 * Finds the path to the Java executable within the specified directory.
 */
async function findJavaExecutable(extractDir, platform) {
  try {
    const stats = await fs.stat(extractDir);
    if (!stats.isDirectory()) return null;

    let javaExecutablePath;

    if (platform === 'win32') {
      const directPath = path.join(extractDir, 'bin', 'java.exe');
      try {
        await fs.access(directPath, fs.constants.X_OK);
        javaExecutablePath = directPath;
      } catch {
        const entries = await fs.readdir(extractDir, { withFileTypes: true });
        const firstDir = entries.find(e => e.isDirectory());
        if (firstDir) {
          const subDirPath = path.join(extractDir, firstDir.name, 'bin', 'java.exe');
          try {
             await fs.access(subDirPath, fs.constants.X_OK);
             javaExecutablePath = subDirPath;
          } catch { /* ignore */ }
        }
      }
    } else if (platform === 'darwin') {
      javaExecutablePath = path.join(extractDir, 'Contents', 'Home', 'bin', 'java');
    } else {
      javaExecutablePath = path.join(extractDir, 'bin', 'java');
    }

    if (javaExecutablePath) {
        await fs.access(javaExecutablePath, fs.constants.X_OK);
        return javaExecutablePath;
    }
    return null;
  } catch {
    return null;
  }
}

// --- Main Exported Function ---

/**
 * Downloads and extracts Java, or returns existing path if version matches.
 */
export async function downloadJava({
  version = DEFAULT_JAVA_VERSION,
  destinationDir = path.join(os.tmpdir(), `downloaded-java-${crypto.randomBytes(4).toString('hex')}`),
  imageType = DEFAULT_IMAGE_TYPE,
  vendor = 'eclipse',
  jvmImpl = 'hotspot',
} = {}) {

  const platformInfo = getApiOsArch();
  if (!platformInfo) return null;
  const { os: apiOs, arch: apiArch } = platformInfo;
  const currentPlatform = os.platform();

  // --- Check if Java executable already exists AND matches version ---
  try {
      const existingJavaPath = await findJavaExecutable(destinationDir, currentPlatform);
      if (existingJavaPath) {
          console.log(`Java executable found at: ${existingJavaPath}. Verifying version...`);
          const existingVersion = await getJavaMajorVersion(existingJavaPath);
          
          if (existingVersion === version) {
              console.log(`Found Java ${existingVersion}. Matches required version. Skipping download.`);
              return existingJavaPath;
          } else {
              console.log(`Found Java ${existingVersion}, but version ${version} is required. Redownloading...`);
              // Optional: Clear directory to prevent mixing versions
              await fs.rm(destinationDir, { recursive: true, force: true });
          }
      }
  } catch (checkError) {
      console.warn(`Error during pre-check: ${checkError.message}.`);
  }

  console.log('Proceeding with Java download...');
  const apiUrl = `${ADOPTIUM_API_BASE}/binary/latest/${version}/ga/${apiOs}/${apiArch}/${imageType}/${jvmImpl}/normal/${vendor}`;

  let downloadUrl;
  let archiveType;

  try {
    const headResponse = await axios.head(apiUrl, { maxRedirects: 10 });
    downloadUrl = headResponse.request.res.responseUrl || headResponse.config.url;

    archiveType = downloadUrl.endsWith('.zip') ? 'zip' : 'tar.gz';

    await fs.mkdir(destinationDir, { recursive: true });

    console.log(`Downloading Java ${version} from Adoptium...`);
    const response = await axios.get(downloadUrl, { responseType: 'arraybuffer' });

    if (archiveType === 'zip') {
      const zip = new AdmZip(response.data);
      zip.extractAllTo(destinationDir, true);
    } else {
      const tempFileName = `java-dl-${crypto.randomBytes(4).toString('hex')}.tar.gz`;
      const tempFilePath = path.join(os.tmpdir(), tempFileName);
      await fs.writeFile(tempFilePath, response.data);
      await tar.x({
        file: tempFilePath,
        cwd: destinationDir,
        strip: 1,
      });
      await fs.unlink(tempFilePath);
    }

    const javaPath = await findJavaExecutable(destinationDir, currentPlatform);

    if (javaPath) {
      const installedVersion = await getJavaMajorVersion(javaPath);
      console.log(`Successfully installed Java ${installedVersion} at: ${javaPath}`);
      return javaPath;
    } else {
      console.error('Failed to find Java executable after extraction.');
      return null;
    }

  } catch (error) {
    console.error(`Java download/extraction failed: ${error.message}`);
    return null;
  }
}