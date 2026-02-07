import { writeFileSync } from "node:fs";
import { test262LoadCache, test262PersistCache } from "../src/test262/cache.ts";
import { TEST262_METADATA } from "../src/test262/constants.ts";
import {
	test262Checkout,
	test262CollectFiles,
	test262ListFiles,
} from "../src/test262/files.ts";
import { test262Log } from "../src/test262/log.ts";
import { getFailuresWithSamples, test262RunFile } from "../src/test262/runtime.ts";

const cacheContext = test262LoadCache();

if (!cacheContext.files.length) {
	test262Checkout();

	const fileIterator = test262ListFiles();
	const files = await test262CollectFiles(fileIterator);

	cacheContext.files = files;
	test262PersistCache(cacheContext);
}

let i = 0;

for (const file of cacheContext.files) {
	i++;
	test262RunFile(file);

	if (i % 3000 === 0) {
		test262Log(`Progress: ${i} / ${cacheContext.files.length}`);
	}
}

const result = cacheContext.files.reduce<Record<string, number>>((acc, file) => {
	acc[file.result] = (acc[file.result] ?? 0) + 1;
	return acc;
}, {});

test262Log(`Result: `, result);

const failures = getFailuresWithSamples();
test262Log(JSON.stringify(failures, null, 2));

if (!("UNKNOWN" in result)) {
	writeFileSync(
		TEST262_METADATA.outputFile,
		JSON.stringify(
			{
				sha: TEST262_METADATA.sha,
				summary: result,
				results: Object.fromEntries(
					cacheContext.files.map((file) => [
						file.path,
						file.result === "PASSED" ? "PASSED"
						: file.result === "SKIPPED" ? "SKIPPED"
						: "FAILED",
					]),
				),
			},
			null,
			2,
		),
	);
	test262Log("Updated results in the repository.");
}
