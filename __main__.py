# main.py
import os
import platform
import pathlib
import json
import hashlib
import asyncio
import logging
import sys
import zipfile
import shutil  # For copytree and rmtree
from typing import Dict, Any, List, Optional, Union

import aiohttp
import aiofiles
import aiofiles.os
from tqdm.asyncio import tqdm # Use tqdm's async version

# --- Local Imports ---
try:
    # Assuming java.py and replacer.py are in the same directory
    from java import download_java
    from replacer import replace_text
except ImportError as e:
    print(f"Error importing local modules (java.py, replacer.py): {e}")
    print("Please ensure these files are in the same directory as main.py.")
    sys.exit(1)

# --- Logging Setup ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
log = logging.getLogger(__name__)

# --- Constants and Configuration ---
DEFAULT_VERSION_MANIFEST = 'neoforge-21.1.162.json' # Default if not in launcher_config
SCRIPT_DIR = pathlib.Path(__file__).parent.resolve()

# Load launcher_config.json and patch paths
try:
    with open(SCRIPT_DIR / "launcher_config.json", 'r') as f:
        launcher_config_raw = json.load(f)
except FileNotFoundError:
    log.error("launcher_config.json not found in the script directory.")
    sys.exit(1)
except json.JSONDecodeError as e:
    log.error(f"Error parsing launcher_config.json: {e}")
    sys.exit(1)

# Patch launcher config immediately (replace_text is synchronous)
launcher_config = {}
for key, value in launcher_config_raw.items():
    launcher_config[key] = replace_text(value, {':thisdir:': str(SCRIPT_DIR)})

log.info(f"Launcher config: {json.dumps(launcher_config, indent=2)}")

# Main target version manifest filename from launcher_config or default
TARGET_VERSION_MANIFEST_FILENAME = launcher_config.get('version', DEFAULT_VERSION_MANIFEST)

# Load user config (config.json) if it exists
cfg = {}
try:
    config_path = SCRIPT_DIR / 'config.json'
    if config_path.exists():
        # Reading small config at start is often acceptable synchronously.
        with open(config_path, 'r', encoding='utf-8') as f:
            cfg = json.load(f)
except json.JSONDecodeError as e:
    log.warning(f"Could not parse config.json: {e}. Using defaults.")
except Exception as e:
    log.warning(f"Could not read config.json: {e}. Using defaults.")

# --- Authentication Details ---
AUTH_PLAYER_NAME = cfg.get("auth_player_name") if cfg.get("auth_player_name") else 'Player'
AUTH_UUID = cfg.get("auth_uuid") if cfg.get("auth_uuid") else '00000000-0000-0000-0000-000000000000'
AUTH_ACCESS_TOKEN = cfg.get("auth_access_token") if cfg.get("auth_access_token") else '00000000000000000000000000000000'
AUTH_XUID = cfg.get("auth_xuid") if cfg.get("auth_xuid") else '0'
USER_TYPE = 'msa'

# --- Directories ---
BASE_PATH = pathlib.Path(launcher_config.get('basepath', SCRIPT_DIR / '.mc_launcher_data'))
MINECRAFT_DIR = BASE_PATH / launcher_config.get('path', '.minecraft')
VERSIONS_DIR = MINECRAFT_DIR / 'versions'
LIBRARIES_DIR = MINECRAFT_DIR / 'libraries'
ASSETS_DIR = MINECRAFT_DIR / 'assets'
ASSET_INDEXES_DIR = ASSETS_DIR / 'indexes'
ASSET_OBJECTS_DIR = ASSETS_DIR / 'objects'
LAUNCHER_PROFILES_PATH = MINECRAFT_DIR / 'launcher_profiles.json'
CLIENT_STORAGE_PATH = MINECRAFT_DIR / 'client_storage.json'
BACKUP_PATH_BASE = SCRIPT_DIR / '.minecraft_autobackup'
JAVA_INSTALL_DIR = SCRIPT_DIR / 'java-runtime'

# --- Helper Functions ---

async def get_file_sha1(file_path: pathlib.Path) -> str:
    """Calculates the SHA1 hash of a file asynchronously."""
    sha1_hash = hashlib.sha1()
    try:
        async with aiofiles.open(file_path, 'rb') as f:
            while True:
                chunk = await f.read(8192)
                if not chunk:
                    break
                sha1_hash.update(chunk)
        return sha1_hash.hexdigest()
    except FileNotFoundError:
        raise FileNotFoundError(f"File not found for SHA1 calculation: {file_path}")
    except Exception as e:
        raise RuntimeError(f"Error calculating SHA1 for {file_path}: {e}")

async def file_exists(file_path: pathlib.Path) -> bool:
    """Checks if a file exists asynchronously."""
    try:
        stats = await aiofiles.os.stat(file_path)
        # Check if it's a regular file using stat results
        return stats.st_mode & 0o100000 != 0
    except OSError: # Includes FileNotFoundError
        return False

# Shared aiohttp session
AIOHTTP_SESSION = None

async def get_session():
    global AIOHTTP_SESSION
    if AIOHTTP_SESSION is None or AIOHTTP_SESSION.closed:
        AIOHTTP_SESSION = aiohttp.ClientSession()
    return AIOHTTP_SESSION

async def close_session():
    global AIOHTTP_SESSION
    if AIOHTTP_SESSION and not AIOHTTP_SESSION.closed:
        await AIOHTTP_SESSION.close()
        AIOHTTP_SESSION = None

async def download_file(
    url: str,
    dest_path: pathlib.Path,
    expected_sha1: Optional[str],
    force_download: bool = False,
    pbar: Optional[tqdm] = None # Progress bar instance passed in
) -> bool:
    """Downloads a file asynchronously, verifies SHA1 hash."""
    dir_path = dest_path.parent
    await aiofiles.os.makedirs(dir_path, exist_ok=True)

    needs_download = force_download
    exists = await file_exists(dest_path)

    if exists and not force_download:
        if expected_sha1:
            try:
                current_sha1 = await get_file_sha1(dest_path)
                if current_sha1.lower() == expected_sha1.lower():
                    if pbar: pbar.update(1) # Update progress even if skipped
                    return False # No download needed
                else:
                    log.warning(f"SHA1 mismatch for existing file {dest_path.name}. Expected {expected_sha1}, got {current_sha1}. Redownloading.")
                    needs_download = True
            except Exception as hash_error:
                log.warning(f"Warning: Could not hash existing file {dest_path}. Redownloading. Error: {hash_error}")
                needs_download = True
        else:
            if pbar: pbar.update(1)
            return False # File exists, no hash check, no download needed
    elif not exists:
        needs_download = True

    if not needs_download:
        if pbar: pbar.update(1) # Ensure progress updates if no download needed
        return False

    session = await get_session()
    try:
        async with session.get(url) as response:
            if not response.ok:
                # Clean up potentially corrupted file before throwing
                try:
                    if await aiofiles.os.path.exists(dest_path): await aiofiles.os.remove(dest_path)
                except OSError: pass # Ignore deletion errors
                raise aiohttp.ClientResponseError(
                    response.request_info, response.history,
                    status=response.status, message=f"Failed to download {url}: {response.reason}", headers=response.headers
                )
            # Stream download to file
            async with aiofiles.open(dest_path, 'wb') as f:
                async for chunk in response.content.iter_chunked(8192):
                    await f.write(chunk)

        if expected_sha1:
            downloaded_sha1 = await get_file_sha1(dest_path)
            if downloaded_sha1.lower() != expected_sha1.lower():
                raise ValueError(f"SHA1 mismatch for {dest_path.name}. Expected {expected_sha1}, got {downloaded_sha1}")

        if pbar: pbar.update(1) # Update progress after successful download
        return True # Download occurred

    except Exception as error:
        log.error(f"Error downloading {url}: {error}")
        # Clean up potentially incomplete file
        try:
            if await aiofiles.os.path.exists(dest_path): await aiofiles.os.remove(dest_path)
        except OSError: pass
        if pbar: pbar.close() # Stop progress bar on error
        raise # Re-throw to stop the process

# Sync zip extraction (run in executor)
def _extract_zip_sync(jar_path: pathlib.Path, extract_to_dir: pathlib.Path):
    try:
        with zipfile.ZipFile(jar_path, 'r') as zip_ref:
            for member in zip_ref.infolist():
                # Skip directories and META-INF
                if not member.is_dir() and not member.filename.upper().startswith('META-INF/'):
                    try:
                        # Preserve directory structure within the zip
                        zip_ref.extract(member, extract_to_dir)
                    except Exception as extract_error:
                         log.warning(f"Warning: Could not extract {member.filename} from {jar_path.name}. Error: {extract_error}")
    except zipfile.BadZipFile:
        log.error(f"Failed to read zip file (BadZipFile): {jar_path}")
        raise
    except Exception as e:
        log.error(f"Failed to process zip file {jar_path}: {e}")
        raise

async def extract_natives(jar_path: pathlib.Path, extract_to_dir: pathlib.Path):
    """Extracts native libraries from a JAR file asynchronously."""
    await aiofiles.os.makedirs(extract_to_dir, exist_ok=True)
    loop = asyncio.get_running_loop()
    # Run the synchronous extraction function in a thread pool executor
    await loop.run_in_executor(None, _extract_zip_sync, jar_path, extract_to_dir)


def get_os_name() -> str:
    """Gets the current OS name ('windows', 'osx', 'linux')."""
    system = platform.system()
    if system == 'Windows': return 'windows'
    elif system == 'Darwin': return 'osx'
    elif system == 'Linux': return 'linux'
    else: raise OSError(f"Unsupported platform: {system}")

def get_arch_name() -> str:
    """Gets the current architecture name ('x64', 'x86', 'arm64', 'arm32')."""
    machine = platform.machine().lower()
    if machine in ['amd64', 'x86_64']: return 'x64'
    elif machine in ['i386', 'i686']: return 'x86'
    elif machine in ['arm64', 'aarch64']: return 'arm64'
    elif machine.startswith('arm') and '64' not in machine: return 'arm32'
    else:
        # Fallback or error for less common architectures
        log.warning(f"Unsupported architecture: {platform.machine()}. Falling back to 'x64'. This might cause issues.")
        return 'x64'


# --- Rule Processing ---

def check_rule(rule: Optional[Dict[str, Any]]) -> bool:
    """
    Checks if a *single rule* permits an item based on the current environment.
    Returns True if the rule permits inclusion, False otherwise.
    """
    if not rule or 'action' not in rule:
        return True  # Default allow if no rule/action specified

    action = rule.get('action', 'allow')
    applies = True  # Assume the condition matches unless proven otherwise

    # Check OS condition
    if 'os' in rule and isinstance(rule['os'], dict):
        os_rule = rule['os']
        current_os = get_os_name()
        current_arch = get_arch_name()
        if 'name' in os_rule and os_rule['name'] != current_os:
            applies = False
        if applies and 'arch' in os_rule and os_rule['arch'] != current_arch:
            applies = False
        # Version check omitted for simplicity

    # Check features condition
    if applies and 'features' in rule and isinstance(rule['features'], dict):
        features_rule = rule['features']
        # Get feature flags from config or use defaults
        is_demo = cfg.get('demo', False)
        has_custom_res = True # Assume true like JS example, maybe get from cfg?

        # Check specific features mentioned in the rule.
        # If *any* specified feature condition is NOT met, 'applies' becomes False.
        if 'is_demo_user' in features_rule:
            if features_rule['is_demo_user'] != is_demo:
                applies = False
        if applies and 'has_custom_resolution' in features_rule:
             if features_rule['has_custom_resolution'] != has_custom_res:
                 applies = False
        # Add other feature checks here based on rule.features keys similarly...

    # Evaluate the rule's final outcome based on action and condition match
    if action == 'allow':
        # Allow action: Item permitted only if conditions apply
        return applies
    elif action == 'disallow':
        # Disallow action: Item permitted only if conditions *do not* apply
        return not applies
    else:
        log.warning(f"Unknown rule action: {action}. Defaulting to allow.")
        return True

def check_item_rules(rules: Optional[List[Dict[str, Any]]]) -> bool:
    """
    Checks if an item (library/argument) should be included based on its rules array.
    Implements the logic: Disallow if *any* rule prevents inclusion.
    """
    if not rules:
        return True  # No rules, always include (default allow)

    # Assume allowed unless a rule forbids it
    allowed = True
    for rule in rules:
        # check_rule returns True if this specific rule *permits* inclusion
        if not check_rule(rule):
            # If check_rule is False, this rule prevents inclusion
            allowed = False
            # log.debug(f"Item disallowed by rule: {rule}") # Optional debug
            break # No need to check further rules, it's disallowed

    return allowed

# --- End Rule Processing ---


async def ensure_launcher_profiles(current_version_id: str):
    """Ensures launcher_profiles.json exists and contains basic info."""
    log.info('Checking launcher profiles...')
    profile_name = f"custom-{current_version_id}"
    # Generate profile key from UUID (consistent with vanilla launcher)
    auth_profile_key = AUTH_UUID.replace('-', '')
    account_key = f"account-{auth_profile_key}" # Used in newer profile formats

    # Basic structure
    profiles_data = {
        "profiles": {
            profile_name: {
                # "created": datetime.now().isoformat(), # Optional
                # "icon": "Furnace", # Optional
                "lastUsed": "1970-01-01T00:00:00.000Z", # Needs update on launch
                "lastVersionId": current_version_id,
                "name": profile_name,
                "type": "custom"
                # "javaArgs": "-Xmx2G", # Optional
                # "gameDir": str(MINECRAFT_DIR) # Optional
            }
        },
        "authenticationDatabase": {
             account_key: {
                 "accessToken": AUTH_ACCESS_TOKEN,
                 "profiles": {
                     auth_profile_key: {
                         "displayName": AUTH_PLAYER_NAME,
                         "playerUUID": AUTH_UUID,
                         "userId": AUTH_XUID,
                         # "texture": "..." # Optional base64 skin/cape
                     }
                 },
                 "username": AUTH_PLAYER_NAME, # Often email for MSA
                 "properties": [], # Optional user properties
                 # "remoteId": "...", # Xbox user ID
             }
        },
        "settings": {
            # "locale": "en-us",
            # "showMenu": True,
            # ... other launcher settings
        },
        "selectedUser": {
             "account": account_key,
             "profile": auth_profile_key
        },
        "version": 4 # Common version number for this format
    }
    try:
        # Ensure directory exists first
        await aiofiles.os.makedirs(LAUNCHER_PROFILES_PATH.parent, exist_ok=True)
        # Write the file asynchronously
        async with aiofiles.open(LAUNCHER_PROFILES_PATH, 'w', encoding='utf-8') as f:
            await f.write(json.dumps(profiles_data, indent=2))
        log.info(f"Created/updated {LAUNCHER_PROFILES_PATH}")
    except Exception as error:
        log.error(f"Failed to write {LAUNCHER_PROFILES_PATH}: {error}")
        raise RuntimeError("Could not write launcher profiles file.")


async def load_manifest(filename: str) -> Dict[str, Any]:
    """Loads a JSON manifest file from the script's directory asynchronously."""
    file_path = SCRIPT_DIR / filename
    log.info(f"Loading manifest: {filename}")
    try:
        async with aiofiles.open(file_path, 'r', encoding='utf-8') as f:
            content = await f.read()
        return json.loads(content)
    except FileNotFoundError:
        log.error(f"Manifest file not found: {file_path}")
        raise
    except json.JSONDecodeError as e:
        log.error(f"Failed to parse manifest {filename}: {e}")
        raise ValueError(f"Invalid JSON in manifest: {filename}")
    except Exception as e:
        log.error(f"Failed to load manifest {filename}: {e}")
        raise

def merge_manifests(target_manifest: Dict[str, Any], base_manifest: Dict[str, Any]) -> Dict[str, Any]:
    """Merges two version manifests (target inheriting from base)."""
    target_id = target_manifest.get('id', 'unknown-target')
    base_id = base_manifest.get('id', 'unknown-base')
    log.info(f"Merging manifests: {target_id} inheriting from {base_id}")

    # Combine libraries: Use a dictionary keyed by 'name' for overrides.
    combined_libraries_map = {}
    for lib in base_manifest.get('libraries', []):
        if 'name' in lib: combined_libraries_map[lib['name']] = lib
    for lib in target_manifest.get('libraries', []):
        if 'name' in lib: combined_libraries_map[lib['name']] = lib # Overwrite

    # Combine arguments: Append target args to base args.
    base_args = base_manifest.get('arguments', {}) or {}
    target_args = target_manifest.get('arguments', {}) or {}
    combined_arguments = {
        "game": (base_args.get('game', []) or []) + (target_args.get('game', []) or []),
        "jvm": (base_args.get('jvm', []) or []) + (target_args.get('jvm', []) or [])
    }

    # Construct merged manifest, prioritizing target values.
    merged = {
        "id": target_manifest.get('id'),
        "time": target_manifest.get('time'),
        "releaseTime": target_manifest.get('releaseTime'),
        "type": target_manifest.get('type'),
        "mainClass": target_manifest.get('mainClass'), # Target overrides
        "assetIndex": target_manifest.get('assetIndex', base_manifest.get('assetIndex')), # Prefer target
        "assets": target_manifest.get('assets', base_manifest.get('assets')), # Asset ID string
        "downloads": base_manifest.get('downloads'), # Use base downloads (client.jar etc.)
        "javaVersion": target_manifest.get('javaVersion', base_manifest.get('javaVersion')), # Prefer target
        "libraries": list(combined_libraries_map.values()), # Convert dict values back to list
        "arguments": combined_arguments,
        "logging": target_manifest.get('logging', base_manifest.get('logging')), # Prefer target
        "complianceLevel": target_manifest.get('complianceLevel', base_manifest.get('complianceLevel')),
        "minimumLauncherVersion": target_manifest.get('minimumLauncherVersion', base_manifest.get('minimumLauncherVersion'))
    }
    # Clean up None values from .get() fallbacks
    return {k: v for k, v in merged.items() if v is not None}

# Sync backup function (to be run in executor)
def _create_backup_sync(source_dir: pathlib.Path, backup_dir_base: pathlib.Path):
    """Copies source to backup dir, zips it, then removes backup dir."""
    backup_dir = backup_dir_base # Directory to copy into first
    backup_zip_path = backup_dir_base.with_suffix('.zip')

    log.info(f"Starting backup copy from {source_dir} to {backup_dir}")
    # Remove old backup directory/zip if they exist
    if backup_zip_path.exists():
        log.debug(f"Removing existing backup zip: {backup_zip_path}")
        backup_zip_path.unlink()
    if backup_dir.exists():
        log.debug(f"Removing existing intermediate backup dir: {backup_dir}")
        shutil.rmtree(backup_dir)

    # Copy the entire directory
    shutil.copytree(source_dir, backup_dir, dirs_exist_ok=True)
    log.info(f"Backup copy complete. Zipping {backup_dir} to {backup_zip_path}")

    # Zip the backup directory
    with zipfile.ZipFile(backup_zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for root, _, files in os.walk(backup_dir):
            for file in files:
                file_path = pathlib.Path(root) / file
                # Arcname is the path inside the zip file relative to backup_dir
                arcname = file_path.relative_to(backup_dir)
                zipf.write(file_path, arcname)
    log.info(f"Backup zip created at {backup_zip_path}")

    # Remove the temporary backup directory after zipping
    shutil.rmtree(backup_dir)
    log.info(f"Removed intermediate backup directory {backup_dir}")

# --- Main Execution ---
async def main():
    try:
        # 1. Load Target Manifest
        target_manifest = await load_manifest(TARGET_VERSION_MANIFEST_FILENAME)
        target_version_id = target_manifest.get('id')
        if not target_version_id:
             raise ValueError(f"Target manifest {TARGET_VERSION_MANIFEST_FILENAME} is missing required 'id' field.")

        # 2. Load Base Manifest if needed and Merge
        final_manifest = target_manifest
        if 'inheritsFrom' in target_manifest:
            base_version_id = target_manifest['inheritsFrom']
            base_manifest_filename = f"{base_version_id}.json"
            try:
                base_manifest = await load_manifest(base_manifest_filename)
                final_manifest = merge_manifests(target_manifest, base_manifest)
            except (FileNotFoundError, ValueError, KeyError, Exception) as e:
                log.error(f"Could not load or merge base manifest '{base_manifest_filename}' specified in {TARGET_VERSION_MANIFEST_FILENAME}: {e}")
                sys.exit(1)
        else:
            log.info(f"Manifest {target_version_id} does not inherit from another version.")

        # --- Use finalManifest for all subsequent steps ---
        version_id = final_manifest.get('id') # Should be the target ID after merge
        if not version_id:
             raise ValueError("Final merged manifest is missing the 'id' field.")

        version_dir = VERSIONS_DIR / version_id
        natives_dir = version_dir / f"{version_id}-natives"

        log.info(f"Preparing Minecraft {version_id}...")
        os_name = get_os_name()
        arch_name = get_arch_name()
        log.info(f"Detected OS: {os_name}, Arch: {arch_name}")

        # 4. Ensure Directories and Launcher Profiles
        log.info(f"Ensuring base directory exists: {MINECRAFT_DIR}")
        # Create all necessary directories asynchronously and concurrently
        await asyncio.gather(
            aiofiles.os.makedirs(MINECRAFT_DIR, exist_ok=True),
            aiofiles.os.makedirs(VERSIONS_DIR, exist_ok=True),
            aiofiles.os.makedirs(LIBRARIES_DIR, exist_ok=True),
            aiofiles.os.makedirs(ASSETS_DIR, exist_ok=True),
            aiofiles.os.makedirs(version_dir, exist_ok=True),
            aiofiles.os.makedirs(natives_dir, exist_ok=True),
            aiofiles.os.makedirs(ASSET_INDEXES_DIR, exist_ok=True),
            aiofiles.os.makedirs(ASSET_OBJECTS_DIR, exist_ok=True)
        )
        # Create/update launcher profiles
        await ensure_launcher_profiles(version_id)

        # 5. Copy *Target* Version Manifest JSON to Version Directory
        target_manifest_source_path = SCRIPT_DIR / TARGET_VERSION_MANIFEST_FILENAME
        dest_manifest_path = version_dir / f"{version_id}.json"
        try:
            log.info(f"Copying {target_manifest_source_path.name} to {dest_manifest_path}")
            # Run synchronous copy in executor to avoid blocking
            await asyncio.get_running_loop().run_in_executor(
                None, shutil.copyfile, target_manifest_source_path, dest_manifest_path
            )
        except Exception as error:
            log.error(f"Failed to copy target version manifest: {error}")
            raise RuntimeError(f"Could not copy version manifest file: {target_manifest_source_path}")

        # 6. Download Client JAR
        log.info('Checking client JAR...')
        client_info = final_manifest.get('downloads', {}).get('client')
        if not (client_info and 'url' in client_info and 'sha1' in client_info):
            raise ValueError(f"Merged manifest for {version_id} is missing client download information (url, sha1).")
        client_jar_path = version_dir / f"{version_id}.jar"
        # Use tqdm context for the single download (async with not supported, manual create/close)
        client_pbar = tqdm(total=1, desc="Client JAR", unit="file", leave=False)
        try:
            await download_file(client_info['url'], client_jar_path, client_info['sha1'], pbar=client_pbar)
        finally:
            client_pbar.close()


        # 7. Prepare Library List
        log.info('Processing library list...')
        libraries_to_process = []
        classpath_entries_set = {str(client_jar_path)} # Use a set to avoid duplicates
        native_library_paths = []

        for lib in final_manifest.get('libraries', []):
            # Check rules for the entire library entry FIRST
            if not check_item_rules(lib.get('rules')):
                # log.debug(f"Skipping library due to overall rules: {lib.get('name', 'N/A')}")
                continue

            lib_name = lib.get('name', 'unknown-library')
            downloads = lib.get('downloads', {})
            artifact = downloads.get('artifact')
            classifiers = downloads.get('classifiers', {})
            natives_rules = lib.get('natives', {}) # Legacy natives mapping

            # --- Determine Native Classifier ---
            native_classifier_key = None
            native_info = None
            # Check 'natives' mapping first (less common now)
            if os_name in natives_rules:
                raw_classifier = natives_rules[os_name]
                # Replace ${arch} - Python needs specific replacement logic
                arch_replace = '64' if arch_name == 'x64' else ('32' if arch_name == 'x86' else arch_name)
                potential_key = raw_classifier.replace('${arch}', arch_replace)
                if potential_key in classifiers:
                    native_classifier_key = potential_key
                    native_info = classifiers[native_classifier_key]
                    # log.debug(f"Found native classifier via 'natives' rule: {native_classifier_key}")

            # Check standard 'classifiers' if not found via 'natives'
            if not native_info and classifiers:
                 # Construct potential keys based on current OS/Arch
                potential_keys = [
                    f"natives-{os_name}-{arch_name}",
                    f"natives-{os_name}",
                ]
                for key in potential_keys:
                    if key in classifiers:
                        native_classifier_key = key
                        native_info = classifiers[key]
                        # log.debug(f"Found native classifier via standard key: {key}")
                        break

            # --- Add Main Artifact ---
            if artifact and artifact.get('path') and artifact.get('url'):
                # Rules specific to the artifact itself are not standard in manifests.
                # We rely on the top-level library rules check done earlier.
                lib_path = LIBRARIES_DIR / artifact['path']
                libraries_to_process.append({
                    "name": lib_name,
                    "url": artifact['url'],
                    "path": lib_path,
                    "sha1": artifact.get('sha1'),
                    "is_native": False,
                })
                classpath_entries_set.add(str(lib_path)) # Add non-native to classpath

            # --- Add Native Artifact ---
            if native_info and native_info.get('path') and native_info.get('url'):
                # Again, rely on top-level library rules. Classifier-specific rules aren't standard.
                native_path = LIBRARIES_DIR / native_info['path']
                libraries_to_process.append({
                    "name": f"{lib_name}:{native_classifier_key}", # Include classifier in name for clarity
                    "url": native_info['url'],
                    "path": native_path,
                    "sha1": native_info.get('sha1'),
                    "is_native": True,
                })
                native_library_paths.append(native_path) # Keep track of native JARs for extraction

        # Download Libraries (Corrected tqdm usage)
        log.info(f"Downloading {len(libraries_to_process)} library files...")
        lib_pbar = tqdm(total=len(libraries_to_process), desc="Libraries", unit="file", leave=False)
        try:
            download_tasks = [
                download_file(lib_info['url'], lib_info['path'], lib_info['sha1'], pbar=lib_pbar)
                for lib_info in libraries_to_process
            ]
            await asyncio.gather(*download_tasks)
        finally:
            lib_pbar.close()
        log.info('Library download check complete.')

        classpath_entries = list(classpath_entries_set) # Convert classpath set back to list

        # 8. Extract Natives
        log.info('Extracting native libraries...')
        # Clear existing natives directory first
        try:
            if await aiofiles.os.path.isdir(natives_dir):
                 log.debug(f"Removing existing natives directory: {natives_dir}")
                 # Run synchronous rmtree in executor
                 await asyncio.get_running_loop().run_in_executor(None, shutil.rmtree, natives_dir)
            await aiofiles.os.makedirs(natives_dir, exist_ok=True)
        except Exception as err:
            log.warning(f"Could not clear/recreate natives directory {natives_dir}: {err}. Extraction might fail or use old files.")

        if native_library_paths:
            # Corrected tqdm usage for natives
            native_pbar = tqdm(total=len(native_library_paths), desc="Natives", unit="file", leave=False)
            try:
                extract_tasks = []
                for native_jar_path in native_library_paths:
                     # Define task within loop to capture correct native_jar_path
                     async def extract_task(jar_path, pbar_instance):
                         try:
                             await extract_natives(jar_path, natives_dir)
                         except Exception as e:
                              log.error(f"\nFailed to extract natives from: {jar_path.name}: {e}")
                              # Decide if you want to raise or just log
                              # raise # Uncomment to stop on first extraction error
                         finally:
                              pbar_instance.update(1)

                     extract_tasks.append(extract_task(native_jar_path, native_pbar))
                await asyncio.gather(*extract_tasks)
            finally:
                 native_pbar.close() # Ensure pbar is closed
        else:
            log.info("No native libraries to extract for this platform.")
        log.info('Native extraction complete.')


        # 9. Download Assets
        log.info('Checking assets...')
        asset_index_info = final_manifest.get('assetIndex')
        if not (asset_index_info and 'id' in asset_index_info and 'url' in asset_index_info and 'sha1' in asset_index_info):
            raise ValueError(f"Merged manifest for {version_id} is missing asset index information (id, url, sha1).")

        asset_index_id = asset_index_info['id']
        asset_index_filename = f"{asset_index_id}.json"
        asset_index_path = ASSET_INDEXES_DIR / asset_index_filename

        # Download asset index (Corrected tqdm usage)
        idx_pbar = tqdm(total=1, desc="Asset Index", unit="file", leave=False)
        try:
             await download_file(asset_index_info['url'], asset_index_path, asset_index_info['sha1'], pbar=idx_pbar)
        finally:
             idx_pbar.close()

        # Load asset index content
        try:
            async with aiofiles.open(asset_index_path, 'r', encoding='utf-8') as f:
                asset_index_content = json.loads(await f.read())
        except Exception as e:
            raise RuntimeError(f"Failed to read downloaded asset index {asset_index_path}: {e}")

        asset_objects = asset_index_content.get('objects', {})
        total_assets = len(asset_objects)
        log.info(f"Checking {total_assets} asset files listed in index {asset_index_id}...")

        # Download assets (Corrected tqdm usage)
        asset_pbar = tqdm(total=total_assets, desc="Assets", unit="file", leave=False)
        try:
            asset_download_tasks = []
            for asset_key, asset_details in asset_objects.items():
                asset_hash = asset_details.get('hash')
                if not asset_hash:
                    log.warning(f"Asset '{asset_key}' is missing hash in index, skipping.")
                    asset_pbar.update(1); continue # Still count it towards progress

                hash_prefix = asset_hash[:2]
                asset_subdir = ASSET_OBJECTS_DIR / hash_prefix
                asset_filepath = asset_subdir / asset_hash
                # Standard Minecraft asset download URL structure
                asset_url = f"https://resources.download.minecraft.net/{hash_prefix}/{asset_hash}"
                asset_download_tasks.append(
                    download_file(asset_url, asset_filepath, asset_hash, pbar=asset_pbar)
                )
            await asyncio.gather(*asset_download_tasks)
        finally:
            asset_pbar.close() # Ensure pbar is closed
        log.info('Asset check complete.')

        # 10. Download and Setup Java Runtime
        java_version_info = final_manifest.get('javaVersion')
        if not (java_version_info and 'majorVersion' in java_version_info):
             log.warning("Manifest does not specify Java major version. Attempting default.")
             required_java_major = DEFAULT_JAVA_VERSION # Use default from java.py
        else:
             required_java_major = java_version_info['majorVersion']

        log.info(f"Checking/Installing Java {required_java_major}...")
        java_executable = await download_java(
            version=required_java_major,
            destination_dir_str=str(JAVA_INSTALL_DIR) # Pass as string
            # imageType='jre' # Optionally force JRE
        )

        if not java_executable:
             log.error(f"Failed to obtain a suitable Java {required_java_major} executable.")
             log.error(f"Ensure Java {required_java_major} is installed and accessible, or allow the script to download it to {JAVA_INSTALL_DIR}.")
             sys.exit(1)
        log.info(f"Using Java executable: {java_executable}")


        # 11. Handle Client Storage (for NeoForge setup tracking)
        log.info("Loading client storage...")
        client_storage = {}
        try:
            if await aiofiles.os.path.exists(CLIENT_STORAGE_PATH):
                async with aiofiles.open(CLIENT_STORAGE_PATH, 'r', encoding='utf-8') as f:
                    client_storage = json.loads(await f.read())
            else:
                 # Initialize if file doesn't exist
                 client_storage = {"setupNeoForge": []} # Start with empty list
        except json.JSONDecodeError as e:
            log.warning(f"Failed to load or parse {CLIENT_STORAGE_PATH}: {e}. Reinitializing.")
            client_storage = {"setupNeoForge": []} # Reinitialize on error
        except Exception as e:
             log.error(f"Error handling {CLIENT_STORAGE_PATH}: {e}. Reinitializing.")
             client_storage = {"setupNeoForge": []}

        # Ensure setupNeoForge exists and is a list (migration from old boolean)
        if "setupNeoForge" not in client_storage or not isinstance(client_storage.get("setupNeoForge"), list):
             client_storage["setupNeoForge"] = []


        # 12. Run NeoForge Installer if necessary
        needs_neoforge_setup = False
        if version_id.startswith("neoforge-") and version_id not in client_storage.get("setupNeoForge", []):
            needs_neoforge_setup = True
            neoforge_installer_jar = SCRIPT_DIR / 'neoinstaller.jar'
            if not await aiofiles.os.path.isfile(neoforge_installer_jar):
                log.warning(f"NeoForge version detected ({version_id}), but neoinstaller.jar not found at {neoforge_installer_jar}. Skipping automatic setup.")
                needs_neoforge_setup = False # Cannot perform setup

        if needs_neoforge_setup:
            log.info(f"Setting up NeoForge for {version_id}...")
            # Command structure: java -jar neoinstaller.jar --install-client <minecraft_dir>
            setup_command_args = [
                java_executable,
                "-jar",
                str(neoforge_installer_jar),
                "--install-client",
                str(MINECRAFT_DIR) # Pass the .minecraft dir path
            ]

            log.info(f"Running NeoForge setup command: {' '.join(setup_command_args)}")
            # Run the installer process
            process = await asyncio.create_subprocess_exec(
                *setup_command_args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(SCRIPT_DIR) # Run from script dir to find installer jar easily?
            )

            stdout, stderr = await process.communicate()

            if stdout: log.info("NeoForge Installer Output:\n" + stdout.decode(errors='ignore'))
            if stderr: log.error("NeoForge Installer Errors:\n" + stderr.decode(errors='ignore'))

            if process.returncode == 0:
                log.info("NeoForge setup completed successfully.")
                # Update client storage
                client_storage["setupNeoForge"].append(version_id) # Assumes it's a list
                try:
                    async with aiofiles.open(CLIENT_STORAGE_PATH, 'w', encoding='utf-8') as f:
                        await f.write(json.dumps(client_storage, indent=2))
                except Exception as e:
                    log.error(f"Failed to update {CLIENT_STORAGE_PATH} after NeoForge setup: {e}")
            else:
                log.error(f"NeoForge setup failed with exit code {process.returncode}. Minecraft might not launch correctly.")
                # Decide if you want to exit here or try launching anyway
                # sys.exit(1)


        # 13. Construct Launch Command
        log.info('Constructing launch command...')
        classpath_separator = os.pathsep # Use ';' for Windows, ':' for Linux/macOS
        classpath_string = classpath_separator.join(classpath_entries)

        # Argument Placeholder Replacements
        replacements = {
            '${natives_directory}': str(natives_dir),
            '${library_directory}': str(LIBRARIES_DIR),
            '${classpath_separator}': classpath_separator,
            '${launcher_name}': 'CustomPythonLauncher',
            '${launcher_version}': '1.0',
            '${classpath}': classpath_string,
            '${auth_player_name}': AUTH_PLAYER_NAME,
            '${version_name}': version_id,
            '${game_directory}': str(MINECRAFT_DIR),
            '${assets_root}': str(ASSETS_DIR),
            '${assets_index_name}': asset_index_id, # Use the ID from assetIndex
            '${auth_uuid}': AUTH_UUID,
            '${auth_access_token}': AUTH_ACCESS_TOKEN,
            '${clientid}': 'N/A', # Placeholder
            '${auth_xuid}': AUTH_XUID,
            '${user_type}': USER_TYPE,
            '${version_type}': final_manifest.get('type', 'release'), # Use manifest type
            '${resolution_width}': cfg.get('resolution_width', '854'),
            '${resolution_height}': cfg.get('resolution_height', '480'),
        }

        def replace_placeholders(arg_template: str) -> str:
            """Replaces all placeholders in a single argument string."""
            replaced_arg = arg_template
            for key, value in replacements.items():
                replaced_arg = replaced_arg.replace(key, value)
            return replaced_arg

        # --- Process JVM Arguments (Using corrected rule logic) ---
        jvm_args = []
        for arg_entry in final_manifest.get('arguments', {}).get('jvm', []):
            arg_values_to_add = [] # List to hold processed args for this entry
            rules = None
            process_this_entry = True

            if isinstance(arg_entry, str):
                # Simple string argument, implicitly allowed (no rules)
                arg_values_to_add.append(replace_placeholders(arg_entry))
            elif isinstance(arg_entry, dict):
                # Argument object with potential rules
                rules = arg_entry.get('rules')
                # Check rules BEFORE processing value
                if not check_item_rules(rules):
                    # log.debug(f"Skipping JVM arg object due to rules: {arg_entry.get('value', '')}")
                    process_this_entry = False # Skip this whole dict entry
                else:
                    # Rules allow, now process the value(s)
                    value_from_dict = arg_entry.get('value')
                    if isinstance(value_from_dict, list):
                        arg_values_to_add.extend(replace_placeholders(val) for val in value_from_dict)
                    elif isinstance(value_from_dict, str):
                        arg_values_to_add.append(replace_placeholders(value_from_dict))
                    else:
                        log.warning(f"Unsupported value type in JVM arg object: {value_from_dict}")
                        process_this_entry = False
            else:
                 log.warning(f"Unsupported JVM argument format: {arg_entry}")
                 process_this_entry = False # Skip unknown format

            # Add processed arguments if the entry was allowed and processed
            if process_this_entry:
                for arg in arg_values_to_add:
                    # Basic quoting for -D properties with spaces
                    if arg.startswith("-D") and "=" in arg:
                        key, value = arg.split("=", 1)
                        if " " in value and not (value.startswith('"') and value.endswith('"')):
                            arg = f'{key}="{value}"'
                    jvm_args.append(arg)

        # --- Process Game Arguments (Using corrected rule logic) ---
        game_args = []
        for arg_entry in final_manifest.get('arguments', {}).get('game', []):
            arg_values_to_add = []
            rules = None
            process_this_entry = True

            if isinstance(arg_entry, str):
                arg_values_to_add.append(replace_placeholders(arg_entry))
            elif isinstance(arg_entry, dict):
                rules = arg_entry.get('rules')
                if not check_item_rules(rules):
                    # log.debug(f"Skipping game arg object due to rules: {arg_entry.get('value', '')}")
                    process_this_entry = False
                else:
                    value_from_dict = arg_entry.get('value')
                    if isinstance(value_from_dict, list):
                        arg_values_to_add.extend(replace_placeholders(val) for val in value_from_dict)
                    elif isinstance(value_from_dict, str):
                        arg_values_to_add.append(replace_placeholders(value_from_dict))
                    else:
                        log.warning(f"Unsupported value type in game arg object: {value_from_dict}")
                        process_this_entry = False
            else:
                 log.warning(f"Unsupported game argument format: {arg_entry}")
                 process_this_entry = False

            if process_this_entry:
                game_args.extend(arg_values_to_add)


        # 14. Launch Minecraft
        main_class = final_manifest.get('mainClass')
        if not main_class:
            raise ValueError("Final manifest is missing the 'mainClass' required for launch.")

        final_launch_args = [
            java_executable,
            *jvm_args,
            main_class,
            *game_args,
        ]

        log.info("Attempting to launch Minecraft...")
        # Optionally log the full command for debugging, but be careful with tokens
        # log.debug(f"Launch command: {' '.join(final_launch_args)}")

        # Run the Minecraft process
        mc_process = await asyncio.create_subprocess_exec(
            *final_launch_args,
            stdout=sys.stdout, # Redirect child stdout to parent's stdout
            stderr=sys.stderr, # Redirect child stderr to parent's stderr
            cwd=MINECRAFT_DIR # Set the working directory to .minecraft
        )

        log.info(f"Minecraft process started (PID: {mc_process.pid}). Waiting for exit...")

        # Wait for the process to complete
        return_code = await mc_process.wait()

        # 15. Post-Launch Actions (Backup)
        log.info(f"Minecraft process exited with code {return_code}.")

        # Perform backup if configured
        if cfg.get("backup", False):
            log.info("Backup requested. Creating backup...")
            try:
                 loop = asyncio.get_running_loop()
                 # Run the synchronous backup function in the executor
                 await loop.run_in_executor(None, _create_backup_sync, MINECRAFT_DIR, BACKUP_PATH_BASE)
                 log.info("Backup process completed.")
            except Exception as backup_error:
                 log.error(f"Failed to create backup: {backup_error}", exc_info=True)
        else:
             log.info("Backup disabled in config.")

    except Exception as e:
        log.exception("--- An error occurred during setup or launch ---")
        # Optionally add more specific error handling or cleanup
        sys.exit(1)
    finally:
        # Ensure the shared aiohttp session is closed on exit or error
        await close_session()


# --- Script Entry Point ---
if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("Launch cancelled by user.")
        # Ensure session is closed if KeyboardInterrupt happens before finally block in main
        # Running close_session within a new asyncio.run context
        try:
            asyncio.run(close_session())
        except RuntimeError: # Can happen if loop is already closed
             pass
    # Note: SystemExit from sys.exit() will also terminate the script here