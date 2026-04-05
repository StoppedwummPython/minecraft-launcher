#!/bin/bash

# --- Usage ---
# ./create_macos_app.sh YourAppName /path/to/your/exec.sh

# --- Script ---

# 1. Input Validation
if [ "$#" -ne 2 ]; then
    echo "Usage: $0 AppName PathToExecutableScript"
    exit 1
fi

APP_NAME="$1"
EXEC_SCRIPT_PATH="$2"
EXEC_SCRIPT_NAME=$(basename "$EXEC_SCRIPT_PATH")

if [ ! -f "$EXEC_SCRIPT_PATH" ]; then
    echo "Error: Executable script not found at '$EXEC_SCRIPT_PATH'"
    exit 1
fi

# 2. Define the Application Bundle Structure
APP_DIR="${APP_NAME}.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

# 3. Create the Directory Structure
echo "Creating directory structure for $APP_NAME.app..."
mkdir -p "$MACOS_DIR"
mkdir -p "$RESOURCES_DIR"

# 4. Copy the Executable and Make It Executable
echo "Copying script and setting permissions..."
cp "$EXEC_SCRIPT_PATH" "$MACOS_DIR/$APP_NAME"
chmod +x "$MACOS_DIR/$APP_NAME"

# 5. Create the Info.plist File
echo "Creating Info.plist..."
PLIST_FILE="$CONTENTS_DIR/Info.plist"

cat <<EOF > "$PLIST_FILE"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>${APP_NAME}</string>
    <key>CFBundleIdentifier</key>
    <string>com.example.${APP_NAME}</string>
    <key>CFBundleName</key>
    <string>${APP_NAME}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
</dict>
</plist>
EOF

echo ""
echo "$APP_NAME.app has been created successfully!"
echo "You can now run it by double-clicking it in Finder."
