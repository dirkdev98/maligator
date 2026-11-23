const request = process.argv[2];
const builtin = process.getBuiltinModule(request);
if (builtin !== require("node:os")) throw new Error("builtin identity");
const load = require;
try {
	load(request);
} catch (error) {
	console.log(String(error));
}
