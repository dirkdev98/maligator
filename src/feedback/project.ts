import { existsSync } from "node:fs";
import * as path from "node:path";
import { BUILD_CONFIG_NAME } from "../cli-init.ts";

/**
 * The directory a feedback file names its modules and units relative to, so a
 * recording made from any working directory, and a later build reading it,
 * agree on them: the directory of the build config the command resolves, else
 * the entry's nearest directory with a package.json.
 */
export function feedbackProjectRoot(
	entry: string,
	configPath: string | undefined,
	cwd = process.cwd(),
): string {
	const config = path.resolve(cwd, configPath ?? BUILD_CONFIG_NAME);
	if (existsSync(config)) return path.dirname(config);
	const start = path.dirname(path.resolve(cwd, entry));
	for (let directory = start; ; directory = path.dirname(directory)) {
		if (existsSync(path.join(directory, "package.json"))) return directory;
		if (path.dirname(directory) === directory) return start;
	}
}

/**
 * A module's key in a feedback file: its path relative to the project root with
 * `/` separators, so dependencies stay paths into node_modules. Virtual modules,
 * which have no file, keep their id.
 */
export function feedbackModuleKey(root: string, modulePath: string): string {
	if (!path.isAbsolute(modulePath)) return modulePath;
	return path.relative(root, modulePath).split(path.sep).join("/");
}
