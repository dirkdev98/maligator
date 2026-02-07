import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { TEST262_METADATA } from "./constants.ts";
import { test262Log } from "./log.ts";
import type { Test262Cache } from "./types.ts";

export function test262LoadCache() {
	if (!existsSync(TEST262_METADATA.cacheFile)) {
		test262Log("No cache found.");
		return {
			sha: TEST262_METADATA.sha,
			files: [],
		};
	}

	const cacheContents = JSON.parse(
		readFileSync(TEST262_METADATA.cacheFile, "utf-8"),
	) as Test262Cache;

	if (cacheContents.sha !== TEST262_METADATA.sha) {
		test262Log("Ignoring cache for a different revision.");

		return {
			sha: TEST262_METADATA.sha,
			files: [],
		};
	}

	test262Log(`Using ${cacheContents.files.length} cached files.`);

	return cacheContents;
}

export function test262PersistCache(cache: Test262Cache) {
	writeFileSync(TEST262_METADATA.cacheFile, JSON.stringify(cache));
}
