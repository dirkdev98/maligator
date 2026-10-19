import module, {
	constants,
	enableCompileCache,
	findPackageJSON,
	getSourceMapsSupport,
	globalPaths,
	registerHooks,
} from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const lines = [];
const show = (label, value) => lines.push(`${label} ${JSON.stringify(value)}`);
const root = process.cwd();
const base = pathToFileURL(`${root}/`).href;
const relative = (value) =>
	typeof value === "string" ? path.relative(root, value) : value;

show("constants", constants);
show("compile cache", [typeof enableCompileCache().status, module.flushCompileCache()]);
show("source maps", getSourceMapsSupport());
show("globalPaths", [
	Array.isArray(globalPaths),
	globalPaths.every((entry) => typeof entry === "string"),
]);
show("Module", module.Module === module);
show("hooks", typeof registerHooks({}).deregister);
show("node module paths", module._nodeModulePaths("/a/node_modules/b/c"));
show(
	"findPackageJSON absolute",
	relative(findPackageJSON(path.join(root, "src", "index.ts"), base)),
);
show(
	"findPackageJSON url",
	relative(findPackageJSON(pathToFileURL(path.join(root, "src", "index.ts")), base)),
);
show(
	"findPackageJSON relative",
	relative(findPackageJSON("./src/index.ts", pathToFileURL(`${root}/`).href)),
);
show(
	"findPackageJSON bare",
	relative(
		findPackageJSON("vitest", pathToFileURL(path.join(root, "src", "index.ts")).href),
	),
);
for (const run of [
	() => findPackageJSON(1),
	() => findPackageJSON(path.join(root, "missing-file.js"), base),
]) {
	try {
		run();
	} catch (error) {
		show("findPackageJSON error", error.code);
	}
}
console.log(lines.join("\n"));
