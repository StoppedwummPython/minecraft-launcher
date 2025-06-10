/**
 * Replace all occurrences of {{key}} in a given string with the corresponding values from a given object.
 * @param {string} text - The string to perform replacements on.
 * @param {object} replacements - An object where keys are the substrings
 *                                to find and values are the strings to
 *                                replace them with.
 * @throws If the text is not a string or if the replacements object is not valid.
 * @returns The string with all specified replacements made.
 */
export default function replaceText(text, replacements) {
  if (!text || !replacements || typeof replacements !== 'object') {
    throw new Error('Invalid arguments: text must be a string and replacements must be an object.');
  }

  let result = text;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replaceAll("${{" + key + "}}", value);
  }
  return result;
}