import type { Test262File } from "./types.ts";

export interface Test262SharedHelper {
	id: string;
	path: string;
	source: string;
}

export interface Test262SourcePlan {
	helpers: Array<Test262SharedHelper>;
	testSource: string;
}

/** Each harness file is a separate global script, regardless of the test's parse goal. */
export function planTest262SharedHelpers(
	file: Test262File,
	loadHarness: (name: string) => string,
): Test262SourcePlan {
	if (file.frontmatter.flags?.includes("raw")) {
		return { helpers: [], testSource: file.content };
	}
	const names = ["assert.js", "sta.js"];
	if (file.frontmatter.flags?.includes("async")) names.push("doneprintHandle.js");
	names.push(...(file.frontmatter.includes ?? []));
	return {
		helpers: names.map((name) => ({
			id: name,
			path: `harness/${name}`,
			source: loadHarness(name),
		})),
		testSource: file.content,
	};
}

export function test262SourcePlanCacheInput(plan: Test262SourcePlan): string {
	return JSON.stringify(plan);
}
