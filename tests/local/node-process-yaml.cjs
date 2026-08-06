const processModule = require("process");
const { parse } = require("yaml");

const parsed = parse("status: ok\n");
const checks = [
	processModule === process,
	typeof processModule.emitWarning === "function",
	parsed.status === "ok",
];

console.log("RESULT " + checks.filter(Boolean).length + "/" + checks.length);
