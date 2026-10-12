import path from "node:path";
import * as canonical from "node:path/posix";
import posix, { join, normalize, resolve, parse, relative } from "path/posix";
const results = [
	[
		"identity",
		path.posix === posix,
		canonical.default === posix,
		canonical.join === join,
		path.posix.join === join,
	],
	[
		"values",
		join("a", "..", "b"),
		normalize("/a//b/../"),
		resolve("/a", "../b"),
		parse("/a/file.ext"),
		relative("/a/b", "/a/c"),
	],
];
Object.defineProperty(path, "posix", {
	get() {
		throw new Error("read");
	},
});
results.push([
	"cached",
	process.getBuiltinModule("path/posix") === posix,
	process.getBuiltinModule("node:path/posix") === posix,
]);
console.log(JSON.stringify(results));
