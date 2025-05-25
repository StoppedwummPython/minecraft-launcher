import { createInterface } from "readline";
import fs from "fs/promises"
const manifest = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"

const manifests = await fetch(manifest)
if (!manifests.ok) throw new Error("Failed to fetch version manifest")
const json = await manifests.json()

function getInput(prompt) {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise(resolve => {
        rl.question(prompt, answer => {
            rl.close();
            resolve(answer);
        });
    });
}

const choice = await getInput("Select a version (0 for latest): ")

let version = null

if (choice.trim() == "0") {
    version = json.versions.find(version => version.id == json.latest.release)
} else {
    version = json.versions.find(version => version.id == choice)
}

// download version manifest
const url = version.url
const response = await fetch(url)
if (!response.ok) throw new Error("Failed to fetch version manifest")
// save it to disk
await fs.writeFile(version.id + ".json", await response.text())