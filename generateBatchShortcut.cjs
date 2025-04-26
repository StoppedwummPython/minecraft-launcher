const path = require('path');
const fs = require('fs/promises');

// --- Your existing path definitions ---
const userDesktop = path.join(require('os').homedir(), 'Desktop'); // User's desktop path
const projectRootDir = __dirname; // Define project root explicitly
const minecraftDir = path.join(projectRootDir, '.minecraft'); // Define specific directory for batch file
const batchFilePath = path.join(minecraftDir, 'launch.bat');

// --- Your batch file content ---
// Make sure paths in batch file content are correct relative to execution context
// Using absolute paths within the batch file might be more robust if __dirname causes issues when run via shortcut
const batchFileContent = `@echo off
REM Using absolute path for cd is often safer when run via shortcut
cd /d "${projectRootDir}"
IF NOT EXIST "node_modules" call npm i
IF NOT EXIST "config.json" node config_generator.js
IF NOT EXIST "config.json" (
  echo ERROR: config.json not found and could not be generated.
  pause
  exit /b 1
)
node .
`; // Added error message and pause if config fails

// --- Main async function ---
(async () => {
  try {
    // 1. Ensure the target directory for the batch file exists
    await fs.mkdir(minecraftDir, { recursive: true });
    console.log(`Ensured directory exists: ${minecraftDir}`);

    // 2. Write the batch file
    await fs.writeFile(batchFilePath, batchFileContent, { encoding: 'utf-8' });
    console.log(`Batch file created successfully at: ${batchFilePath}`);

    // 3. Create the shortcut
  } catch (error) {
    console.error(`Error creating batch file: ${error.message}`);
    return;
  }
})();