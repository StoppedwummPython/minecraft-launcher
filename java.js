// javaDownloader.js
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import axios from 'axios';
import AdmZip from 'adm-zip';
import * as tar from 'tar'; // Correct import

// --- Configuration ---
const ADOPTIUM_API_BASE = 'https://api.adoptium.net/v3';
const DEFAULT_JAVA_VERSION = 17;
const DEFAULT_IMAGE_TYPE = 'jdk';

// --- Helper Functions ---

/**
 * Maps Node.js os.platform() and os.arch() to Adoptium API values.
 * @returns {object|null} Object with { os, arch } for API or null if unsupported.
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
    default:
      console.error(`Unsupported operating system: ${platform}`);
      return null;
  }

  switch (arch) {
    case 'x64': apiArch = 'x64'; break;
    case 'arm64': apiArch = 'aarch64'; break;
    default:
      console.error(`Unsupported architecture: ${arch}`);
      return null;
  }

  return { os: apiOs, arch: apiArch };
}

/**
 * Finds the path to the Java executable within the specified directory.
 * Assumes the archive contents (after potential stripping) are directly in extractDir.
 * Checks standard locations based on OS.
 * @param {string} extractDir - The directory where Java files (bin/Contents) are expected.
 * @param {string} platform - The OS platform ('win32', 'darwin', 'linux').
 * @returns {Promise<string|null>} Absolute path to the java executable or null if not found/accessible.
 */
async function findJavaExecutable(extractDir, platform) {
  // console.debug(`Searching for Java executable in ${extractDir} for platform ${platform}`); // Optional debug
  try {
    // Ensure the base directory exists before trying to access sub-paths
    // Use stat to check if it's actually a directory, access just checks existence
    const stats = await fs.stat(extractDir);
    if (!stats.isDirectory()) {
      // console.debug(`Provided path ${extractDir} is not a directory.`); // Optional debug
      return null;
    }

    let javaExecutablePath;

    // Construct the expected path based on OS, assuming strip:1 was used for tarballs
    if (platform === 'win32') {
      // On Windows (zip), adm-zip extracts contents directly if archive has top-level dir.
      // Or structure might be directly bin/java.exe if archive didn't have top-level dir.
      // Let's check both the base dir and the first subdirectory found.
      const directPath = path.join(extractDir, 'bin', 'java.exe');
      try {
        await fs.access(directPath, fs.constants.X_OK);
        javaExecutablePath = directPath;
      } catch {
        // Try finding the first subdirectory (like jdk-...) and look inside it
        const entries = await fs.readdir(extractDir, { withFileTypes: true });
        const firstDir = entries.find(e => e.isDirectory());
        if (firstDir) {
          const subDirPath = path.join(extractDir, firstDir.name, 'bin', 'java.exe');
          try {
             await fs.access(subDirPath, fs.constants.X_OK);
             javaExecutablePath = subDirPath;
          } catch { /* Subdir path failed */ }
        }
      }

    } else if (platform === 'darwin') {
      // After tar strip:1, expect Contents/Home/bin/java directly in extractDir
      javaExecutablePath = path.join(extractDir, 'Contents', 'Home', 'bin', 'java');
    } else { // Linux
      // After tar strip:1, expect bin/java directly in extractDir
      javaExecutablePath = path.join(extractDir, 'bin', 'java');
    }

    if (!javaExecutablePath) {
        // console.debug(`Could not construct a likely path for java executable in ${extractDir}`); // Optional debug
        return null; // Failed to determine a potential path
    }

    // console.debug(`Checking for executable at: ${javaExecutablePath}`); // Optional debug
    // Verify the final constructed path exists and is executable
    await fs.access(javaExecutablePath, fs.constants.X_OK);
    // console.debug(`Executable found and accessible: ${javaExecutablePath}`); // Optional debug
    return javaExecutablePath; // Return the confirmed path

  } catch (error) {
    // This catches errors from fs.stat, fs.readdir, or the final fs.access check
    // It means either the directory doesn't exist, isn't readable, or the executable
    // is missing/not executable at the expected location.
    // console.debug(`Failed to find or access Java executable in ${extractDir}. Error: ${error.message}`); // Optional debug
    return null; // Indicate failure
  }
}


// --- Main Exported Function ---

/**
 * Downloads and extracts a standalone Java runtime/JDK if not already present.
 *
 * @param {object} options - Download options.
 * @param {number} [options.version=DEFAULT_JAVA_VERSION] - The major Java version (e.g., 11, 17, 21).
 * @param {string} [options.destinationDir=path.join(os.tmpdir(), 'downloaded-java-<random>')] - Directory for Java. **Crucially, if this directory already contains a valid executable, download will be skipped.**
 * @param {string} [options.imageType=DEFAULT_IMAGE_TYPE] - Type of Java package ('jdk' or 'jre').
 * @param {string} [options.vendor='eclipse'] - The build vendor (usually 'eclipse' for Temurin).
 * @param {string} [options.jvmImpl='hotspot'] - The JVM implementation.
 * @returns {Promise<string|null>} The absolute path to the Java executable if successful (found or downloaded), otherwise null.
 */
export async function downloadJava({
  version = DEFAULT_JAVA_VERSION,
  destinationDir = path.join(os.tmpdir(), `downloaded-java-${crypto.randomBytes(4).toString('hex')}`),
  imageType = DEFAULT_IMAGE_TYPE,
  vendor = 'eclipse',
  jvmImpl = 'hotspot',
} = {}) {

  const platformInfo = getApiOsArch();
  if (!platformInfo) {
    return null;
  }
  const { os: apiOs, arch: apiArch } = platformInfo;
  const currentPlatform = os.platform();

  // --- Check if Java executable already exists ---
  console.log(`Checking for existing Java executable in: ${destinationDir}`);
  try {
      const existingJavaPath = await findJavaExecutable(destinationDir, currentPlatform);
      if (existingJavaPath) {
          console.log(`Valid Java executable already found at: ${existingJavaPath}. Skipping download.`);
          return existingJavaPath;
      } else {
           console.log(`Existing Java executable not found or installation is incomplete in ${destinationDir}.`);
      }
  } catch (checkError) {
      console.warn(`Error during pre-check for existing Java: ${checkError.message}. Assuming download is needed.`);
  }
  // --- End Check ---

  console.log('Proceeding with Java download and extraction process...');
  const apiUrl = `${ADOPTIUM_API_BASE}/binary/latest/${version}/ga/${apiOs}/${apiArch}/${imageType}/${jvmImpl}/normal/${vendor}`;
  console.log(`Attempting to download Java ${version} (${imageType}) for ${apiOs}-${apiArch} from Adoptium API.`);

  let downloadUrl;
  let archiveType;

  try {
    console.log(`Fetching download details from: ${apiUrl}`);
    const headResponse = await axios.head(apiUrl, { maxRedirects: 10 });
    downloadUrl = headResponse.request.res.responseUrl || headResponse.config.url;

    if (downloadUrl.endsWith('.zip')) archiveType = 'zip';
    else if (downloadUrl.endsWith('.tar.gz')) archiveType = 'tar.gz';
    else archiveType = (apiOs === 'windows') ? 'zip' : 'tar.gz';

    console.log(`Resolved download URL: ${downloadUrl}`);
    console.log(`Detected archive type: ${archiveType}`);

    await fs.mkdir(destinationDir, { recursive: true });
    console.log(`Ensured destination directory exists: ${destinationDir}`);

    console.log('Starting download...');
    const response = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
    console.log('Download complete.');

    console.log(`Extracting ${archiveType} archive to ${destinationDir}...`);
    if (archiveType === 'zip') {
      const zip = new AdmZip(response.data);
      // AdmZip behavior with top-level dirs can vary; findJavaExecutable tries to handle both cases
      zip.extractAllTo(destinationDir, /*overwrite*/ true);
    } else { // tar.gz
      const tempFileName = `java-dl-${crypto.randomBytes(4).toString('hex')}.tar.gz`;
      const tempFilePath = path.join(os.tmpdir(), tempFileName);
      try {
        await fs.writeFile(tempFilePath, response.data);
        console.log(`Temporary archive saved to: ${tempFilePath}`);
        await tar.x({
          file: tempFilePath,
          cwd: destinationDir,
          strip: 1, // Crucial for consistent structure after extraction
        });
        console.log('Extraction using tar complete.');
        await fs.unlink(tempFilePath);
        console.log(`Temporary file ${tempFilePath} deleted.`);
      } catch (tarError) {
          console.error(`Error during tar extraction or cleanup:`, tarError);
          try { await fs.unlink(tempFilePath); } catch { /* ignore */ }
          throw tarError;
      }
    }
    console.log('Extraction complete.');

    // Find the newly extracted java executable using the revised logic
    const javaPath = await findJavaExecutable(destinationDir, currentPlatform);

    if (javaPath) {
      console.log(`Java executable successfully installed at: ${javaPath}`);
      return javaPath;
    } else {
      // This is now the primary failure point if the structure isn't exactly as expected post-extraction
      console.error('Extraction seemed successful, but failed to find Java executable at the expected location afterwards.');
      console.error(`Please double-check the contents of ${destinationDir} and the logic in findJavaExecutable for platform ${currentPlatform}.`);
      return null;
    }

  } catch (error) {
    // ... (rest of the error handling remains the same) ...
    if (axios.isAxiosError(error)) {
      console.error(`Error downloading Java: ${error.message}`);
      if (error.response) {
          console.error(`Status: ${error.response.status}`);
           if (error.response.status === 404) {
             console.error(`Could not find a build for Java ${version} (${imageType}) for ${apiOs}-${apiArch}. Check Adoptium website for availability.`);
           } else {
             console.error(`Response Data:`, error.response.data?.toString().slice(0, 500)); // Log part of data
           }
      }
    } else {
      console.error(`An unexpected error occurred during download/extraction:`, error);
    }
    console.error(`Java download/extraction failed. Directory ${destinationDir} may be incomplete.`);
    return null;
  }
}