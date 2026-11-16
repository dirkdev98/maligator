const id = JSON.parse('"node:os"');
const first = require(id);
const load = require;
console.log(JSON.stringify([typeof first.platform, first === load(id)]));
