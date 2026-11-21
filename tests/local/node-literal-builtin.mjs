import osDefault from "node:os";
import { DatabaseSync } from "node:sqlite";

const os = process.getBuiltinModule("os");
console.log(
	JSON.stringify([
		typeof os.platform,
		os === process.getBuiltinModule("node:os"),
		os === osDefault,
		process.getBuiltinModule("node:sqlite").DatabaseSync === DatabaseSync,
		process.getBuiltinModule("sqlite") === undefined,
		process.getBuiltinModule("node:fixture-missing-builtin") === undefined,
		typeof process.getBuiltinModule("node:path").join,
	]),
);
