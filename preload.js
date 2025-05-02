import { contextBridge } from 'electron';
import { exec } from 'child_process';

contextBridge.exposeInMainWorld('api', {
  launchMinecraft: () => {
    exec('node index.js', (error, stdout, stderr) => {
      if (error) {
        console.error(`Error: ${error.message}`);
        return 'Failed to launch Minecraft!';
      }
      if (stderr) {
        console.error(`Stderr: ${stderr}`);
      }
      console.log(`Stdout: ${stdout}`);
      return 'Minecraft launched successfully!';
    });
  },
});