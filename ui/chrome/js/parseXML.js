/**
 * Takes a fetch request and parses it as XML.
 * @param {Promise<Response>} fetchRequest the promise from the fetch request.
 * @returns {Promise<Document>} the parsed XML document.
 * @throws {Error} if the fetch request fails or the XML can't be parsed.
 */
export default function parseXML(fetchRequest) {
  return fetchRequest
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response.text();
    })
    .then((text) => {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(text, "application/xml");
      if (xmlDoc.getElementsByTagName("parsererror").length > 0) {
        throw new Error("Error parsing XML");
      }
      return xmlDoc;
    });
}