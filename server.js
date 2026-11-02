const { serveHTTP } = require("stremio-addon-sdk");
const addonInterface = require("./addon");

console.log("Levantando servidor de Stremio...");

serveHTTP(addonInterface, { port: 7000 });
console.log("Addon corriendo en http://localhost:7000/manifest.json");
