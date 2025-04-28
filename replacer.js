/**
 * Replaces all occurrences of specified substrings within a string.
 * Does not use regular expressions.
 *
 * @param {string} value - The original string to perform replacements on.
 * @param {object} replacements - An object where keys are the substrings
 *                                to find and values are the strings to
 *                                replace them with.
 * @returns {string} The string with all specified replacements made.
 *                   Returns the original value if it's not a string
 *                   or if replacements is not a valid object.
 */
export async function replaceText(value, replacements) {
    // Ensure the input value is a string
    if (typeof value !== 'string') {
      console.warn("replaceText: Input 'value' is not a string. Returning original value.");
      return value;
    }
  
    // Ensure replacements is a valid object
    if (typeof replacements !== 'object' || replacements === null) {
      console.warn("replaceText: Input 'replacements' is not a valid object. Returning original value.");
      return value;
    }
  
    let modifiedValue = value;
  
    // Iterate through each key-value pair in the replacements object
    for (const [searchString, replaceString] of Object.entries(replacements)) {
      // Ensure both search and replace values are strings for safety
      if (typeof searchString === 'string' && typeof replaceString === 'string') {
         // Use split() and join() to replace all occurrences
         // split(searchString) breaks the string into an array using searchString as a delimiter
         // join(replaceString) joins the array elements back into a string using replaceString
         modifiedValue = modifiedValue.split(searchString).join(replaceString);
      } else {
         console.warn(`replaceText: Skipping replacement for key '${searchString}' as either key or value is not a string.`);
      }
    }
  
    return modifiedValue;
  }
  
  /*
  Expected Output (assuming __dirname = '/path/to/current/directory'):
  
  Original Config: {
    executable: ':thisdir:/bin/launcher',
    configFile: '/etc/config.conf',
    logPath: ':thisdir:/logs/app.log',
    tempDir: '/tmp',
    description: 'Uses :thisdir: multiple :thisdir: times.'
  }
  Patched Config: {
    executable: '/path/to/current/directory/bin/launcher',
    configFile: '/etc/config.conf',
    logPath: '/path/to/current/directory/logs/app.log',
    tempDir: '/tmp',
    description: 'Uses /path/to/current/directory multiple /path/to/current/directory times.'
  }
  
  */