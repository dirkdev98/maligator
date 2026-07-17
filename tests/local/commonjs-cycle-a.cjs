exports.ready = false;
const b = require("./commonjs-cycle-b.cjs");
exports.bSawA = b.sawA;
exports.b = b;
exports.ready = true;
