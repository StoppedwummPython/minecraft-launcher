const path = require('path');
const fs = require('fs/promises');
const platformfolders = require('platform-folders');
const util = require('util'); // Needed to promisify the callback function

// Try to require windows-shortcuts, provide helpful error if not found
let ws;
try {
  ws = require('windows-shortcuts');
} catch (err) {
  if (err.code === 'MODULE_NOT_FOUND') {
    console.error("\nError: The 'windows-shortcuts' package is required but not found.");
    console.error("Please install it by running: npm install windows-shortcuts\n");
  } else {
    console.error("Error loading 'windows-shortcuts':", err);
  }
  process.exit(1); // Exit if the module is essential and missing
}

// Promisify the callback-based ws.create function for async/await usage
const createShortcut = util.promisify(ws.create);

// --- Your existing path definitions ---
const userDesktop = platformfolders.getDesktopFolder();
const projectRootDir = __dirname; // Define project root explicitly
const minecraftDir = path.join(projectRootDir, '.minecraft'); // Define specific directory for batch file
const batchFilePath = path.join(minecraftDir, 'launch.bat');
const linkPath = path.join(userDesktop, "My Minecraft Launcher.lnk"); // Use .lnk extension! And give it a better name
const iconPath = path.join(projectRootDir, "logo.png"); // Path to your icon (WARN: .ico recommended)

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
    console.log(`Creating shortcut on desktop: ${linkPath}`);
    console.warn("--- Using .png for icon. If it doesn't display correctly, convert logo.png to logo.ico and update iconPath. ---");

    await createShortcut(linkPath, {
      target: batchFilePath,              // Path to the file the shortcut points to
      args: '',                         // Optional arguments for the target
      workingDir: projectRootDir,         // Set the working directory for the batch script
      runStyle: ws.NORMAL,              // How the window should run (NORMAL, MINIMIZED, MAXIMIZED)
      icon: iconPath,                   // Path to the icon file (.ico preferred!)
      desc: 'Launches the custom Minecraft setup' // Description (tooltip) for the shortcut
    });

    console.log('Shortcut created successfully!');

  } catch (error) {
    console.error('\n--- Error during setup ---');
    if (error.message && error.message.includes('EPERM') && error.syscall === 'open' && error.path === linkPath) {
       console.error(`Error: Permission denied writing shortcut to Desktop (${linkPath}).`);
       console.error('Try running the script with administrator privileges if you encounter permissions issues.');
    } else {
        console.error('Detailed Error:', error);
    }
    console.error('---------------------------\n');
  }
})();