// javaDownloader.js
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import axios from 'axios';
import AdmZip from 'adm-zip';
import * as tar from 'tar'; // Corrected import

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
 * Finds the path to the Java executable within the extracted directory.
 * Checks standard locations based on OS.
 * @param {string} extractDir - The directory where Java is expected to be.
 * @param {string} platform - The OS platform ('win32', 'darwin', 'linux').
 * @returns {Promise<string|null>} Absolute path to the java executable or null if not found/accessible.
 */
async function findJavaExecutable(extractDir, platform) {
  // First, check if the target directory exists at all
  try {
    await fs.access(extractDir, fs.constants.F_OK);
  } catch (dirError) {
    // If the directory doesn't exist, we definitely can't find the executable
    // console.debug(`Directory ${extractDir} does not exist.`); // Optional debug log
    return null;
  }

  try {
    const entries = await fs.readdir(extractDir, { withFileTypes: true });
    // Find the *first* directory inside extractDir (e.g., 'jdk-17.0.8+7')
    const javaBaseDirEntry = entries.find(entry => entry.isDirectory());

    if (!javaBaseDirEntry) {
      // It's also possible Java was extracted directly into extractDir without a top-level folder
      // Let's check for bin/java directly in extractDir as a fallback
      console.debug(`No top-level directory found in ${extractDir}. Checking root...`);
      javaBaseDirEntry = { name: '.' }; // Represent the extractDir itself
      // If even this fails, we proceed to construct path based on '.' which might still work if bin exists directly
    }

    const javaBaseDirPath = path.resolve(extractDir, javaBaseDirEntry.name); // Use resolve for robustness
    let javaExecutablePath;

    if (platform === 'win32') {
      javaExecutablePath = path.join(javaBaseDirPath, 'bin', 'java.exe');
    } else if (platform === 'darwin') {
      // Check both potential structures: direct bin and Contents/Home/bin
      const path1 = path.join(javaBaseDirPath, 'bin', 'java');
      const path2 = path.join(javaBaseDirPath, 'Contents', 'Home', 'bin', 'java');
      try {
        await fs.access(path2, fs.constants.X_OK);
        javaExecutablePath = path2;
      } catch {
        // If path2 fails, try path1
         try {
             await fs.access(path1, fs.constants.X_OK);
             javaExecutablePath = path1;
         } catch {
            javaExecutablePath = null; // Neither found/accessible
         }
      }
    } else { // Linux
      javaExecutablePath = path.join(javaBaseDirPath, 'bin', 'java');
    }

    if (!javaExecutablePath) {
        console.error(`Could not construct a potential Java executable path within ${extractDir}.`);
        return null;
    }

    // Verify the executable exists and is executable
    await fs.access(javaExecutablePath, fs.constants.X_OK);
    // console.debug(`Found executable java at: ${javaExecutablePath}`); // Optional debug
    return javaExecutablePath;

  } catch (error) {
    // Log errors related to reading dir or accessing the final executable path
    // This often means the directory exists but is incomplete or permissions are wrong.
    // console.debug(`Error finding/accessing Java executable in ${extractDir}:`, error.message); // Optional debug
    return null; // Indicate failure to find a working executable
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

  // --- Check if Java executable already exists in the destination directory ---
  // Note: This assumes that if an executable exists in destinationDir, it's the correct version/type.
  // For managing multiple distinct versions, use different destinationDir paths.
  console.log(`Checking for existing Java executable in: ${destinationDir}`);
  try {
      const existingJavaPath = await findJavaExecutable(destinationDir, currentPlatform);
      if (existingJavaPath) {
          console.log(`Valid Java executable already found at: ${existingJavaPath}. Skipping download and extraction.`);
          // You could optionally add a check here like running `java -version`
          // to be absolutely sure it matches the requested 'version', but that adds complexity.
          return existingJavaPath; // Return the path to the existing executable
      } else {
           console.log(`Existing Java executable not found or installation is incomplete in ${destinationDir}.`);
      }
  } catch (checkError) {
      // This catch is primarily for unexpected errors during the check itself,
      // not for the case where the executable is simply not found (handled by existingJavaPath being null).
      console.warn(`Error during pre-check for existing Java: ${checkError.message}. Assuming download is needed.`);
  }
  // --- End Check ---

  // If we reach here, Java wasn't found or the check failed, so proceed with download.
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
    else archiveType = (apiOs === 'windows') ? 'zip' : 'tar.gz'; // Fallback

    console.log(`Resolved download URL: ${downloadUrl}`);
    console.log(`Detected archive type: ${archiveType}`);

    // Ensure destination directory exists (might be created here if it didn't exist for the check)
    await fs.mkdir(destinationDir, { recursive: true });
    console.log(`Ensured destination directory exists: ${destinationDir}`);

    // Download
    console.log('Starting download...');
    const response = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
    console.log('Download complete.');

    // Extract
    console.log(`Extracting ${archiveType} archive to ${destinationDir}...`);
    if (archiveType === 'zip') {
      const zip = new AdmZip(response.data);
      zip.extractAllTo(destinationDir, /*overwrite*/ true);
    } else { // tar.gz
      const tempFileName = `java-dl-${crypto.randomBytes(4).toString('hex')}.tar.gz`;
      const tempFilePath = path.join(os.tmpdir(), tempFileName); // Use system temp dir for archive
      try {
        await fs.writeFile(tempFilePath, response.data);
        console.log(`Temporary archive saved to: ${tempFilePath}`);
        await tar.x({
          file: tempFilePath,
          cwd: destinationDir,
          strip: 1, // Stripping 1 component is common for Adoptium archives
        });
        console.log('Extraction using tar complete.');
        await fs.unlink(tempFilePath); // Clean up temp file immediately
        console.log(`Temporary file ${tempFilePath} deleted.`);
      } catch (tarError) {
          console.error(`Error during tar extraction or cleanup:`, tarError);
          try { await fs.unlink(tempFilePath); } catch { /* ignore cleanup error */ }
          throw tarError; // Re-throw
      }
    }
    console.log('Extraction complete.');

    // Find the newly extracted java executable
    // Use findJavaExecutable again to get the *exact* path after extraction
    const javaPath = await findJavaExecutable(destinationDir, currentPlatform);

    if (javaPath) {
      console.log(`Java executable successfully installed at: ${javaPath}`);
      return javaPath;
    } else {
      // This case might happen if extraction succeeded but the structure was unexpected
      console.error('Extraction seemed successful, but failed to find Java executable afterwards.');
      console.error(`Please check the contents of ${destinationDir}`);
      return null;
    }

  } catch (error) {
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
    // Don't automatically clean up destinationDir here, as it might contain useful partial data for debugging
    // Or it might have contained unrelated files if the user provided an existing directory.
    console.error(`Java download/extraction failed. Directory ${destinationDir} may be incomplete.`);
    return null;
  }
}