import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { TEST262_METADATA } from "./constants.ts";
import { test262Log } from "./log.ts";
import type { Test262Cache } from "./types.ts";

export function test262LoadCache(corpusPaths?: ReadonlyArray<string>): Test262Cache {
	if (!existsSync(TEST262_METADATA.cacheFile)) {
		test262Log("No cache found.");
		return {
			schemaVersion: 2,
			sha: "",
			files: [],
		};
	}

	const cacheContents = JSON.parse(
		readFileSync(TEST262_METADATA.cacheFile, "utf-8"),
	) as Test262Cache;
	if (
		cacheContents.schemaVersion !== 2 ||
		cacheContents.sha !== TEST262_METADATA.revision
	) {
		test262Log(
			`Ignoring cached revision ${cacheContents.sha}; expected ${TEST262_METADATA.revision}.`,
		);
		return { schemaVersion: 2, sha: "", files: [] };
	}
	if (
		corpusPaths !== undefined &&
		(cacheContents.files.length !== corpusPaths.length ||
			cacheContents.files.some((file, index) => file.path !== corpusPaths[index]))
	) {
		test262Log("Ignoring cache whose file inventory differs from the pinned corpus.");
		return { schemaVersion: 2, sha: "", files: [] };
	}

	test262Log(`Using ${cacheContents.files.length} cached files at ${cacheContents.sha}.`);

	for (const file of cacheContents.files) {
		file.result = "UNKNOWN";
	}

	return cacheContents;
}

export function test262PersistCache(cache: Test262Cache) {
	mkdirSync(path.dirname(TEST262_METADATA.cacheFile), { recursive: true });
	writeFileSync(TEST262_METADATA.cacheFile, JSON.stringify(cache));
}
