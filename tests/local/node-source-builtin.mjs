import { builtinModules, createRequire, isBuiltin } from "node:module";
const id = process.env.MAL_BUILTIN_ID;
const require = createRequire(import.meta.url);
const output = {
	discovery: [builtinModules.includes(id), isBuiltin(id), isBuiltin("test")],
};
let builtin, required, namespace;
if (process.env.MAL_BUILTIN_ORDER === "import") namespace = await import(id);
if (process.env.MAL_BUILTIN_ORDER === "require") required = require(id);
try {
	builtin = process.getBuiltinModule(id);
	output.builtin = [typeof builtin, typeof builtin?.test];
} catch (error) {
	output.builtin = [error.name, error.code];
}
try {
	required = require(id);
	output.require = [typeof required, typeof required?.test];
} catch (error) {
	output.require = [error.name, error.code];
}
try {
	namespace = await import(id);
	output.import = [
		typeof namespace,
		typeof namespace.default,
		namespace === (await import(id)),
	];
} catch (error) {
	output.import = [error.name, error.code];
}
output.identity = [
	builtin === required,
	required === namespace?.default,
	required === namespace?.test,
];
const bare = id.slice(5);
try {
	require(bare);
	output.bareRequire = "loaded";
} catch (error) {
	output.bareRequire = error.code;
}
output.missingBuiltin = typeof process.getBuiltinModule(`node:missing_${id.length}`);
console.log(JSON.stringify(output));
