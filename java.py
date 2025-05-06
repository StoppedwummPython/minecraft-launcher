import os
import platform
import pathlib
import hashlib
import asyncio
import logging
import zipfile
import tarfile
import tempfile
import secrets # For random hex bytes
import aiohttp
import aiofiles
import aiofiles.os

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
log = logging.getLogger(__name__)

# --- Configuration ---
ADOPTIUM_API_BASE = 'https://api.adoptium.net/v3'
DEFAULT_JAVA_VERSION = 17
DEFAULT_IMAGE_TYPE = 'jdk'

# --- Helper Functions ---

def get_api_os_arch():
    """Maps Python platform/machine to Adoptium API values."""
    system = platform.system()
    machine = platform.machine()

    api_os = None
    api_arch = None

    if system == 'Windows':
        api_os = 'windows'
    elif system == 'Darwin':
        api_os = 'mac'
    elif system == 'Linux':
        api_os = 'linux'
    else:
        log.error(f"Unsupported operating system: {system}")
        return None

    machine = machine.lower()
    if machine in ['amd64', 'x86_64']:
        api_arch = 'x64'
    elif machine in ['arm64', 'aarch64']:
        api_arch = 'aarch64'
    # Add other mappings if needed (e.g., x86, arm32)
    # elif machine in ['i386', 'i686']:
    #    api_arch = 'x86'
    # elif machine.startswith('armv7'):
    #    api_arch = 'arm'
    else:
        log.error(f"Unsupported architecture: {machine}")
        return None

    return {"os": api_os, "arch": api_arch}


# --- Corrected find_java_executable Function ---
async def find_java_executable(extract_dir: pathlib.Path, system: str) -> pathlib.Path | None:
    """
    Finds the path to the Java executable within the specified directory.
    Checks standard locations based on OS. Corrected scandir usage.
    """
    log.info(f"[find_java_executable] Searching in: {extract_dir}")
    try:
        # Use await for checking the main directory existence (could involve I/O)
        if not await aiofiles.os.path.isdir(extract_dir):
            log.warning(f"[find_java_executable] Provided path is not a directory: {extract_dir}")
            return None

        potential_sub_dir = None
        log.debug(f"[find_java_executable] Scanning for subdirectory in {extract_dir}...")
        try:
            # --- CORRECTED USAGE: Use synchronous os.scandir ---
            # No await, no async for. Standard for loop.
            for entry in os.scandir(extract_dir):
                 log.debug(f"[find_java_executable] Found entry: {entry.path} (Name: {entry.name})")
                 try:
                     # entry.is_dir() is synchronous
                     is_dir = entry.is_dir()
                     log.debug(f"[find_java_executable] Is '{entry.name}' a directory? {is_dir}")
                     if is_dir:
                         potential_sub_dir = pathlib.Path(entry.path)
                         log.info(f"[find_java_executable] Found potential Java subdirectory: {potential_sub_dir}")
                         break # Assume first directory found is the right one
                 except OSError as scandir_entry_error:
                     log.warning(f"[find_java_executable] Could not check directory status for {entry.path}: {scandir_entry_error}")
                     continue
        except OSError as e:
            log.warning(f"[find_java_executable] Could not scan directory {extract_dir}: {e}")
            # Continue trying base directory paths even if scan fails

        # Determine which directory to check: the found subdir or the base extract dir
        base_dir_to_check = potential_sub_dir if potential_sub_dir else extract_dir
        log.info(f"[find_java_executable] Selected base directory for final check: {base_dir_to_check}")

        java_executable_path = None
        if system == 'Windows':
            java_executable_path = base_dir_to_check / 'bin' / 'java.exe'
        elif system == 'Darwin':
            java_executable_path = base_dir_to_check / 'Contents' / 'Home' / 'bin' / 'java'
        else:  # Linux
            java_executable_path = base_dir_to_check / 'bin' / 'java'

        log.info(f"[find_java_executable] Constructed full path to check: {java_executable_path}")

        # --- Check 1: File Existence (Use await for aiofiles.os.path) ---
        try:
            is_file = await aiofiles.os.path.isfile(java_executable_path)
            log.info(f"[find_java_executable] Check 1: Does path exist as a file? {is_file}")
        except Exception as e_isfile:
            log.error(f"[find_java_executable] Error checking if path is file: {e_isfile}")
            return None

        if is_file:
            # --- Check 2: Execute Permission (Use synchronous os.access) ---
            try:
                is_executable = os.access(java_executable_path, os.X_OK)
                log.info(f"[find_java_executable] Check 2: Is file executable (os.X_OK)? {is_executable}")
                if is_executable:
                     log.info(f"[find_java_executable] Success! Found accessible executable: {java_executable_path.resolve()}")
                     return java_executable_path.resolve()
                else:
                     log.warning(f"[find_java_executable] File found but not executable: {java_executable_path}")
                     return None
            except Exception as e_access:
                 log.error(f"[find_java_executable] Error checking execute permission with os.access: {e_access}")
                 return None
        else:
            log.warning(f"[find_java_executable] Executable path not found or is not a file.")
            # Fallback logic (only runs if potential_sub_dir was found but failed the check above)
            if potential_sub_dir and base_dir_to_check == potential_sub_dir:
                 log.info(f"[find_java_executable] Retrying search directly in base directory: {extract_dir}")
                 fallback_path = None
                 if system == 'Windows':
                     fallback_path = extract_dir / 'bin' / 'java.exe'
                 elif system == 'Darwin':
                     fallback_path = extract_dir / 'Contents' / 'Home' / 'bin' / 'java'
                 else:
                     fallback_path = extract_dir / 'bin' / 'java'

                 if fallback_path:
                     log.info(f"[find_java_executable] Checking fallback path: {fallback_path}")
                     try:
                         # Use await for async file check
                         fb_is_file = await aiofiles.os.path.isfile(fallback_path)
                         log.info(f"[find_java_executable] Fallback Check 1: Exists as file? {fb_is_file}")
                         if fb_is_file:
                             # Use sync permission check
                             fb_is_executable = os.access(fallback_path, os.X_OK)
                             log.info(f"[find_java_executable] Fallback Check 2: Is executable? {fb_is_executable}")
                             if fb_is_executable:
                                 log.info(f"[find_java_executable] Success on fallback! Found: {fallback_path.resolve()}")
                                 return fallback_path.resolve()
                             else:
                                 log.warning(f"[find_java_executable] Fallback file found but not executable.")
                         else:
                             log.warning(f"[find_java_executable] Fallback path not found or not a file.")
                     except Exception as e_fb:
                         log.error(f"[find_java_executable] Error during fallback check: {e_fb}")

            log.warning(f"[find_java_executable] Could not find executable via primary or fallback paths.")
            return None

    except Exception as e:
        log.exception(f"[find_java_executable] Unexpected error searching in {extract_dir}: {e}") # Use log.exception to get traceback
        return None


# Function to run synchronous extraction in a separate thread
def _extract_zip(zip_data: bytes, dest_path: pathlib.Path):
    import io
    with io.BytesIO(zip_data) as zip_buffer:
        with zipfile.ZipFile(zip_buffer, 'r') as zip_ref:
            zip_ref.extractall(dest_path)

def _extract_tar(tar_path: pathlib.Path, dest_path: pathlib.Path):
    # Check if the tar file exists before trying to open it
    if not tar_path.is_file():
        log.error(f"Tar file not found for extraction: {tar_path}")
        raise FileNotFoundError(f"Tar file not found: {tar_path}")
    try:
        with tarfile.open(tar_path, "r:gz") as tar_ref:
            # tarfile doesn't have a built-in strip_components like the command line
            # We need to manually filter members or extract carefully
            # For simplicity here, we assume strip=1 behaviour is desired and
            # hope the find_java_executable handles the structure.
            # A more robust solution would iterate members and adjust paths.
            tar_ref.extractall(path=dest_path) # This might create a top-level dir
    except tarfile.ReadError as e:
        log.error(f"Error reading tar file {tar_path}: {e}")
        raise
    except Exception as e:
        log.error(f"Unexpected error during tar extraction from {tar_path}: {e}")
        raise

# --- Main Exported Function ---
async def download_java(
    version: int = DEFAULT_JAVA_VERSION,
    destination_dir_str: str | None = None,
    image_type: str = DEFAULT_IMAGE_TYPE,
    vendor: str = 'eclipse',
    jvm_impl: str = 'hotspot',
) -> str | None:
    """
    Downloads and extracts a standalone Java runtime/JDK if not already present.

    Args:
        version: The major Java version (e.g., 11, 17, 21).
        destination_dir_str: Directory for Java. If None, a temporary dir is used.
                           **Crucially, if this directory already contains a valid executable, download will be skipped.**
        image_type: Type of Java package ('jdk' or 'jre').
        vendor: The build vendor (usually 'eclipse' for Temurin).
        jvm_impl: The JVM implementation.

    Returns:
        The absolute path to the Java executable as a string if successful, otherwise None.
    """

    if destination_dir_str is None:
        # Use mkdtemp for a secure temporary directory if none provided
        # Note: This temporary directory won't persist across runs.
        # A fixed path is usually better for caching.
        # Running sync mkdtemp in executor to avoid blocking
        loop = asyncio.get_running_loop()
        temp_dir_str = await loop.run_in_executor(None, tempfile.mkdtemp, f"downloaded-java-{secrets.token_hex(4)}-")
        destination_dir = pathlib.Path(temp_dir_str)
        log.info(f"No destination directory provided, using temporary directory: {destination_dir}")
    else:
        destination_dir = pathlib.Path(destination_dir_str).resolve()


    platform_info = get_api_os_arch()
    if not platform_info:
        return None
    api_os = platform_info["os"]
    api_arch = platform_info["arch"]
    current_system = platform.system()

    # --- Check if Java executable already exists ---
    log.info(f"Checking for existing Java executable in: {destination_dir}")
    try:
        existing_java_path = await find_java_executable(destination_dir, current_system)
        if existing_java_path:
            log.info(f"Valid Java executable already found at: {existing_java_path}. Skipping download.")
            return str(existing_java_path)
        else:
            log.info(f"Existing Java executable not found or installation is incomplete in {destination_dir}.")
    except Exception as check_error:
        # Log the exception details if the check itself fails
        log.exception(f"Error during pre-check for existing Java in {destination_dir}: {check_error}. Assuming download is needed.")
    # --- End Check ---

    log.info('Proceeding with Java download and extraction process...')
    api_url = f"{ADOPTIUM_API_BASE}/binary/latest/{version}/ga/{api_os}/{api_arch}/{image_type}/{jvm_impl}/normal/{vendor}"
    log.info(f"Attempting to download Java {version} ({image_type}) for {api_os}-{api_arch} from Adoptium API.")

    download_url = None
    archive_type = None

    async with aiohttp.ClientSession() as session:
        try:
            log.info(f"Fetching download details (HEAD request) from: {api_url}")
            # Use allow_redirects=True and get the final URL
            async with session.head(api_url, allow_redirects=True) as head_response:
                head_response.raise_for_status() # Raise exception for bad status codes (4xx, 5xx)
                download_url = str(head_response.url) # Get the final URL after redirects

                if not download_url:
                     raise ValueError("Could not resolve download URL after redirects.")

                if download_url.endswith('.zip'):
                    archive_type = 'zip'
                elif download_url.endswith('.tar.gz'):
                    archive_type = 'tar.gz'
                else:
                    # Guess based on OS if extension is missing (less reliable)
                    archive_type = 'zip' if api_os == 'windows' else 'tar.gz'

                log.info(f"Resolved download URL: {download_url}")
                log.info(f"Detected archive type: {archive_type}")

            # Ensure destination directory exists
            # Use await aiofiles.os.makedirs
            await aiofiles.os.makedirs(destination_dir, exist_ok=True)
            log.info(f"Ensured destination directory exists: {destination_dir}")

            log.info('Starting download...')
            async with session.get(download_url) as response:
                response.raise_for_status()
                file_data = await response.read()
            log.info('Download complete.')

            log.info(f"Extracting {archive_type} archive to {destination_dir}...")
            loop = asyncio.get_running_loop()

            if archive_type == 'zip':
                # Run synchronous zip extraction in a thread
                await loop.run_in_executor(None, _extract_zip, file_data, destination_dir)
            else: # tar.gz
                # Write to a temporary file first for tarfile
                temp_tar_path = None
                # Use a context manager for the temporary file
                # Running sync tempfile operations in executor
                fd, temp_tar_path_str = await loop.run_in_executor(None, tempfile.mkstemp, ".tar.gz", "java-dl-")
                os.close(fd) # Close descriptor from mkstemp
                temp_tar_path = pathlib.Path(temp_tar_path_str)

                try:
                    log.debug(f"Saving temporary tar archive to: {temp_tar_path}")
                    async with aiofiles.open(temp_tar_path, 'wb') as f:
                        await f.write(file_data)
                    log.debug(f"Temporary archive saved successfully.")

                    # Run synchronous tar extraction in a thread
                    log.debug(f"Starting tar extraction from {temp_tar_path}...")
                    await loop.run_in_executor(None, _extract_tar, temp_tar_path, destination_dir)
                    log.debug('Extraction using tar complete.')

                finally:
                    # Clean up temporary tar file using await aiofiles.os.remove
                    if temp_tar_path and await aiofiles.os.path.exists(temp_tar_path):
                        try:
                            await aiofiles.os.remove(temp_tar_path)
                            log.debug(f"Temporary file {temp_tar_path} deleted.")
                        except OSError as e:
                            log.warning(f"Could not delete temporary tar file {temp_tar_path}: {e}")
                    elif temp_tar_path:
                         log.debug(f"Temporary file {temp_tar_path} did not exist for deletion.")

            log.info('Extraction complete.')

            # --- Find executable AFTER extraction ---
            # Add a small delay, just in case of filesystem flush issues (optional)
            # await asyncio.sleep(0.5)
            log.info("Re-checking for Java executable after extraction...")
            java_path = await find_java_executable(destination_dir, current_system)

            if java_path:
                log.info(f"Java executable successfully found after extraction at: {java_path}")
                return str(java_path)
            else:
                log.error('Extraction seemed successful, but failed to find Java executable at the expected location afterwards.')
                log.error(f"Please double-check the contents of {destination_dir} and the logic in find_java_executable for platform {current_system}.")
                # Log directory contents for debugging
                try:
                    log.error(f"Contents of {destination_dir}: {os.listdir(destination_dir)}")
                    # Check potential subdir contents too
                    for item in os.listdir(destination_dir):
                        item_path = destination_dir / item
                        if item_path.is_dir():
                             log.error(f"Contents of {item_path}: {os.listdir(item_path)}")
                             bin_path = item_path / 'bin'
                             if bin_path.is_dir():
                                  log.error(f"Contents of {bin_path}: {os.listdir(bin_path)}")
                             break # Show first subdir found
                except Exception as list_err:
                    log.error(f"Could not list directory contents for debugging: {list_err}")
                return None

        except aiohttp.ClientResponseError as e:
            log.error(f"HTTP Error downloading Java: {e.status} {e.message}")
            if e.status == 404:
                log.error(f"Could not find a build for Java {version} ({image_type}) for {api_os}-{api_arch}. Check Adoptium website for availability.")
            else:
                log.error(f"Response Headers: {e.headers}")
                # Try reading response body if available (might be large)
                try:
                     error_body = await e.response.text()
                     log.error(f"Response Body (partial): {error_body[:500]}")
                except Exception:
                     pass # Ignore if body can't be read

            log.error(f"Java download/extraction failed. Directory {destination_dir} may be incomplete.")
            return None
        except Exception as error:
            log.exception(f"An unexpected error occurred during download/extraction: {error}")
            log.error(f"Java download/extraction failed. Directory {destination_dir} may be incomplete.")
            return None

# Example usage (optional, can be run with `python java.py`)
if __name__ == "__main__":
    async def run_test():
        print("Testing Java Downloader...")
        # Define a test destination directory
        test_dest = pathlib.Path("./test-java-runtime").resolve()
        print(f"Will attempt to download Java to: {test_dest}")

        # Clean up previous test run if exists
        if test_dest.exists():
            import shutil
            print("Removing previous test directory...")
            shutil.rmtree(test_dest)

        java_exe_path = await download_java(
            version=21, # Specify version
            destination_dir_str=str(test_dest),
            image_type='jdk'
        )

        if java_exe_path:
            print(f"\nSuccess! Java executable path: {java_exe_path}")
            # Try running java -version
            try:
                 print("\nRunning java -version:")
                 proc = await asyncio.create_subprocess_exec(
                     java_exe_path,
                     "-version",
                     stdout=asyncio.subprocess.PIPE,
                     stderr=asyncio.subprocess.PIPE
                 )
                 stdout, stderr = await proc.communicate()
                 # java -version often prints to stderr
                 print("Exit Code:", proc.returncode)
                 if stderr:
                     print("Output (stderr):\n", stderr.decode())
                 if stdout: # Just in case it prints to stdout
                      print("Output (stdout):\n", stdout.decode())

            except Exception as e:
                print(f"Error running java -version: {e}")
        else:
            print("\nFailed to download or find Java executable.")

    asyncio.run(run_test())