const a = require("./commonjs-cycle-a.cjs");
exports.sawA = a.ready === false;
exports.a = a;
