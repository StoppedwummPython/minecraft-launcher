const path = require('path');
const fs = require('fs/promises');
const platformfolders = require('platform-folders');
// get user desktop path
const userDesktop = platformfolders.getDesktopFolder();
const batchFilePath = path.join(userDesktop, 'Minecraft.bat');
const batchFileContent = `@echo off
cd ${__dirname}
IF NOT EXIST "node_modules" call npm i
IF NOT EXIST "config.json" node config_generator.js
IF NOT EXIST "config.json" exit /b 1
node .`;

(async () => {
  try {
    await fs.writeFile(batchFilePath, batchFileContent, { encoding: 'utf-8' });
    console.log('Batch shortcut created successfully!');
  } catch (error) {
    console.error('Error creating batch shortcut:', error);
  }
})();
