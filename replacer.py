import logging

# Configure logging (optional, but good practice)
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
log = logging.getLogger(__name__)

def replace_text(value: str, replacements: dict) -> str:
    """
    Replaces all occurrences of specified substrings within a string.
    Does not use regular expressions.

    Args:
        value: The original string to perform replacements on.
        replacements: A dictionary where keys are the substrings
                      to find and values are the strings to
                      replace them with.

    Returns:
        The string with all specified replacements made.
        Returns the original value if it's not a string
        or if replacements is not a valid dictionary.
    """
    if not isinstance(value, str):
        log.warning("replace_text: Input 'value' is not a string. Returning original value.")
        return value

    if not isinstance(replacements, dict):
        log.warning("replace_text: Input 'replacements' is not a valid dictionary. Returning original value.")
        return value

    modified_value = value

    # Iterate through each key-value pair in the replacements dictionary
    for search_string, replace_string in replacements.items():
        # Ensure both search and replace values are strings for safety
        if isinstance(search_string, str) and isinstance(replace_string, str):
            # Use str.replace() to replace all occurrences
            modified_value = modified_value.replace(search_string, replace_string)
        else:
            log.warning(f"replace_text: Skipping replacement for key '{search_string}' as either key or value is not a string.")

    return modified_value

# Example Usage (matches the JS comment example)
# if __name__ == "__main__":
#     import os
#     __dirname = os.path.abspath('.') # Simulate __dirname for example

#     original_config = {
#         "executable": ":thisdir:/bin/launcher",
#         "configFile": "/etc/config.conf",
#         "logPath": ":thisdir:/logs/app.log",
#         "tempDir": "/tmp",
#         "description": "Uses :thisdir: multiple :thisdir: times."
#     }

#     replacements = {":thisdir:": __dirname}

#     patched_config = {}
#     for key, value in original_config.items():
#         patched_config[key] = replace_text(value, replacements) # Note: Not async in Python

#     print("Original Config:", original_config)
#     print("Patched Config:", patched_config)

#     # Expected Output (assuming __dirname = '/path/to/current/directory'):
#     # Original Config: {'executable': ':thisdir:/bin/launcher', 'configFile': '/etc/config.conf', 'logPath': ':thisdir:/logs/app.log', 'tempDir': '/tmp', 'description': 'Uses :thisdir: multiple :thisdir: times.'}
#     # Patched Config: {'executable': '/path/to/current/directory/bin/launcher', 'configFile': '/etc/config.conf', 'logPath': '/path/to/current/directory/logs/app.log', 'tempDir': '/tmp', 'description': 'Uses /path/to/current/directory multiple /path/to/current/directory times.'}