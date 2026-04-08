import fs from "fs/promises";
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Define __filename and __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

/**
 * Main function to download the manifest for a specific version.
 * This is what your preload script calls.
 */
async function download(choice) {
    // 1. Fetch the global manifest
    const manifestResponse = await fetch(MANIFEST_URL);
    if (!manifestResponse.ok) throw new Error("Failed to fetch global version manifest");
    const json = await manifestResponse.json();

    let version = null;

    // 2. Logic to find the version
    if (choice === "0" || choice === "latest") {
        version = json.versions.find(v => v.id === json.latest.release);
    } else {
        version = json.versions.find(v => v.id === choice);
    }

    if (!version) {
        throw new Error(`Version ${choice} not found in manifest.`);
    }

    // 3. Download the specific version's manifest
    const response = await fetch(version.url);
    if (!response.ok) throw new Error(`Failed to fetch manifest for version ${version.id}`);
    
    const versionData = await response.json();

    // 4. Save to disk 
    // Note: We use path.join to ensure it saves in the project folder
    const filePath = path.join(process.cwd(), `${version.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(versionData, null, 2));
    
    console.log(`Saved manifest to: ${filePath}`);
    return filePath;
}

/**
 * CLI Support: Only runs if the file is executed directly (node downloadVersionManifest.js)
 */
const isMainModule = import.meta.url === `file://${process.argv[1]}` || process.argv[1] === __filename;

if (isMainModule) {
    // If running via CLI, use the argument passed or default to "0"
    const cliChoice = process.argv[2] || "0";
    download(cliChoice).catch(err => {
        console.error("CLI Error:", err);
        process.exit(1);
    });
}

export default download;