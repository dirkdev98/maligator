import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { TEST262_METADATA } from "./constants.ts";
import { test262Log } from "./log.ts";
import type { Test262Cache } from "./types.ts";

export function test262LoadCache(): Test262Cache {
	if (!existsSync(TEST262_METADATA.cacheFile)) {
		test262Log("No cache found.");
		return {
			sha: "",
			files: [],
		};
	}

	const cacheContents = JSON.parse(
		readFileSync(TEST262_METADATA.cacheFile, "utf-8"),
	) as Test262Cache;

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
