export interface Test262Frontmatter {
	description?: string;
	info?: string;
	features?: Array<string>;
	flags?: Array<string>;
	includes?: Array<string>;
	negative?: {
		phase: "parse" | "early" | "resolution" | "runtime";
		type: string;
	};
	esid?: string;
	author?: string;
}

export interface Test262File {
	path: string;
	frontmatter: Test262Frontmatter;
	content: string;
	result: "UNKNOWN" | "SKIPPED" | "PASSED" | "FAILED" | "STRICT_FAILED";
}

export type Test262Cache = {
	sha: string;
	files: Array<Test262File>;
};
