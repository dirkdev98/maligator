const { probe } = require("./commonjs-probe.cjs");

probe("cjs-child");
module.exports = { value: 45 };
