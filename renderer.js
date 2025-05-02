import { exec } from 'child_process';

document.getElementById('launch-btn').addEventListener('click', () => {
  exec('node index.js', (error, stdout, stderr) => {
    if (error) {
      console.error(`Error: ${error.message}`);
      alert('Failed to launch Minecraft!');
      return;
    }
    if (stderr) {
      console.error(`Stderr: ${stderr}`);
    }
    console.log(`Stdout: ${stdout}`);
    alert('Minecraft launched successfully!');
  });
});