import { createRequire } from "node:module";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const show = (label, value) => console.log(label, JSON.stringify(value));

show("builtins", [
	typeof require("os").EOL,
	require("node:path") === path,
	require("fs") === require("node:fs"),
]);
const target = require("./create-require-target.cjs");
show("commonjs", [
	target.name,
	target.loads,
	require("./create-require-target.cjs") === target,
]);
show("json", require("./commonjs-data.json"));
const esm = require("./commonjs-esm.mjs");
show("esm", [esm.named, esm.default.value]);

const load = (id) => require(id);
show("forwarder", [
	load("./create-require-target.cjs") === target,
	load("os") === require("os"),
]);
var __require = /* @__PURE__ */ ((x) => (typeof require !== "undefined" ? require : x))(
	function (x) {
		if (typeof require !== "undefined") return require.apply(this, arguments);
		throw Error('Dynamic require of "' + x + '" is not supported');
	},
);
show("bundler forwarder", [
	__require("path") === path,
	__require("./create-require-target.cjs") === target,
]);

const specifier = "./create-require-target.cjs";
show("computed", require(specifier) === target);
show("resolve", [
	path.relative(import.meta.dirname, require.resolve("./create-require-target.cjs")),
	require.resolve("fs"),
]);
try {
	require("./create-require-missing.cjs");
} catch (error) {
	show("missing", [error.code, error.message.split("\n")[0]]);
}
try {
	require(["./create-require", "nowhere.cjs"].join("-"));
} catch (error) {
	show("unknown", error.code);
}
show("loads", globalThis.createRequireTargetLoads);
