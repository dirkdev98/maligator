globalThis.mixedRequireEvents = ["wrapper"];
exports.load = () => require("./target.mjs");
exports.fail = () => require("./failure.mjs");
exports.unused = () => require("./unused.mjs");
