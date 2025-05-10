import os
import zipfile
import shutil
import tempfile
import requests
import stat
import platform
import sys
import winshell

# === CONFIGURATION ===
TARGET_DIR = os.path.expanduser("~/Documents/mc")
TAG = "!$!TAG!$!"
ZIP_URL = "https://github.com/StoppedwummPython/minecraft-launcher/archive/refs/tags/" + TAG + ".zip"

def download_zip(url, dest_path):
    print(f"Downloading from {url}...")
    response = requests.get(url, stream=True)
    if response.status_code == 200:
        with open(dest_path, 'wb') as f:
            for chunk in response.iter_content(1024):
                f.write(chunk)
        print("Download complete.")
    else:
        raise Exception(f"Failed to download file: {response.status_code}")

def extract_zip(zip_path, extract_to):
    print(f"Extracting {zip_path}...")
    with zipfile.ZipFile(zip_path, 'r') as zip_ref:
        zip_ref.extractall(extract_to)
    print("Extraction complete.")

def get_inner_folder(path):
    entries = os.listdir(path)
    folders = [entry for entry in entries if os.path.isdir(os.path.join(path, entry))]
    if len(folders) != 1:
        raise Exception("Expected one top-level folder in the ZIP")
    return os.path.join(path, folders[0])

def copy_and_replace(src_dir, dest_dir):
    print(f"Copying files to {dest_dir}...")
    for root, dirs, files in os.walk(src_dir):
        rel_path = os.path.relpath(root, src_dir)
        target_root = os.path.join(dest_dir, rel_path)
        os.makedirs(target_root, exist_ok=True)
        for file in files:
            src_file = os.path.join(root, file)
            dest_file = os.path.join(target_root, file)
            shutil.copy2(src_file, dest_file)
    print("Copy complete.")

def create_run_scripts(path):
    unix_script = f"""#!/bin/bash
cd "{path}"
if [ ! -d "node_modules" ]; then
  npm install
fi
if [ ! -f "config.json" ]; then
  node config_generator.js
fi
npm start
"""

    windows_script = f"""@echo off
cd /d "{path}"
if not exist node_modules (
  npm install
)
if not exist config.json (
  node config_generator.js
)
npm start
"""

    # Create scripts
    run_sh_path = os.path.join(path, "run.sh")
    run_bat_path = os.path.join(path, "run.bat")

    with open(run_sh_path, "w") as f:
        f.write(unix_script)
    os.chmod(run_sh_path, os.stat(run_sh_path).st_mode | stat.S_IEXEC)  # Make executable

    with open(run_bat_path, "w") as f:
        f.write(windows_script)

    print("Launcher scripts created (run.sh, run.bat).")

def main():
    with tempfile.TemporaryDirectory() as tmp_dir:
        zip_path = os.path.join(tmp_dir, "download.zip")
        extract_path = os.path.join(tmp_dir, "extracted")
        
        download_zip(ZIP_URL, zip_path)
        extract_zip(zip_path, extract_path)
        
        inner_folder = get_inner_folder(extract_path)
        copy_and_replace(inner_folder, TARGET_DIR)
        create_run_scripts(TARGET_DIR)
        ICON = os.path.join(TARGET_DIR, "logo.ico")
        if platform.system() == "Windows":
            winshell.shortcut(
                os.path.join(TARGET_DIR, "run.bat"),
                TARGET_DIR,
                "Minecraft Launcher",
                ICON,
                "Minecraft Launcher"
            )
        elif platform.system() == "Linux":
            # Create a .desktop file for Linux
            desktop_file_path = os.path.join(os.path.expanduser("~/.local/share/applications"), "minecraft-launcher.desktop")
            with open(desktop_file_path, "w") as f:
                f.write(f"""[Desktop Entry]
Name=Minecraft Launcher
Exec={os.path.join(TARGET_DIR, "run.sh")}
Type=Application
Icon={ICON}
Terminal=false
StartupNotify=false
""")
            print(f"Desktop entry created at {desktop_file_path}")
        else:
            print("Unsupported OS for creating shortcuts. Please create a shortcut manually.")
        print(f"Launcher installed to {TARGET_DIR}.")

if __name__ == "__main__":
    main()
