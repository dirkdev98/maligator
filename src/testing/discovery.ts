import { readdirSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";

const CONVENTIONAL_TEST = /\.(?:test|spec)\.(?:js|mjs|ts|mts)$/;

function compareNames(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isConventionalTest(filePath: string): boolean {
	return CONVENTIONAL_TEST.test(path.basename(filePath));
}

/**
 * Resolve explicit files/directories into a stable, duplicate-free test file
 * inventory. Explicit files bypass the conventional-name filter.
 */
export function discoverTestFiles(
	selections: Array<string>,
	cwd = process.cwd(),
): Array<string> {
	const inputs = selections.length === 0 ? [cwd] : selections;
	const discovered = new Set<string>();
	const visitedDirectories = new Set<string>();

	const visit = (target: string, explicitFile: boolean): void => {
		const absolute = path.resolve(cwd, target);
		let stats: ReturnType<typeof statSync>;
		try {
			stats = statSync(absolute);
		} catch {
			throw new Error(`test selection does not exist: ${absolute}`);
		}
		if (stats.isFile()) {
			if (explicitFile || isConventionalTest(absolute)) {
				discovered.add(realpathSync(absolute));
			}
			return;
		}
		if (!stats.isDirectory()) {
			if (explicitFile)
				throw new Error(`test selection is not a file or directory: ${absolute}`);
			return;
		}

		const realDirectory = realpathSync(absolute);
		if (visitedDirectories.has(realDirectory)) return;
		visitedDirectories.add(realDirectory);
		for (const name of readdirSync(realDirectory).sort(compareNames)) {
			if (name === ".git" || name === "node_modules" || name === ".cache") continue;
			visit(path.join(realDirectory, name), false);
		}
	};

	for (const selection of inputs) visit(selection, true);
	return [...discovered].sort(compareNames);
}
