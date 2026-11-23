const zlib = require("node:zlib");
const input = Buffer.from("H4sIAAAAAAAAE0vMKchIBABqOeDQBQAAAA==", "base64");
console.log(zlib.gunzipSync(input).toString());
