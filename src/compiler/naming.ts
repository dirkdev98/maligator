import { isNil } from "../utils.ts";
import type { ProgramInformation } from "./program-info.ts";

export function makeUniqueNames(program: ProgramInformation) {
	assignScriptAndModuleNames(program);
}

function assignScriptAndModuleNames(program: ProgramInformation) {
	const rootPath = deriveRootPath(program);

	const usedNames = new Set<string>();
	for (const { key, scriptOrModule } of program.iterateProgramEntries()) {
		const substr = key.slice(rootPath.length);
		let sanitizedName = substr.split(/[/.]/).join("_");

		let suffix = 0;
		while (usedNames.has(sanitizedName)) {
			const potentialName = `${sanitizedName}_${suffix}`;
			if (usedNames.has(potentialName)) {
				suffix++;
				continue;
			}

			sanitizedName = potentialName;
		}

		usedNames.add(sanitizedName);
		scriptOrModule.id = sanitizedName;
	}
}

function deriveRootPath(program: ProgramInformation) {
	const paths = program.iterateProgramEntries().map((it) => it.key.split("/"));

	if (paths.length === 0) {
		return "";
	}

	const pathParts: Array<string> = [];

	while (true) {
		const nextPart = paths[0]?.at(0);
		if (isNil(nextPart)) {
			return pathParts.join("/");
		}

		console.log(paths, nextPart);

		for (const path of paths) {
			if (path[0] !== nextPart) {
				return pathParts.join("/");
			}

			path.shift();
		}

		pathParts.push(nextPart);
	}
}
