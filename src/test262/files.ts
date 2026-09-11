import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	utimesSync,
} from "node:fs";
import * as path from "node:path";
import {
	artifactActionKey,
	artifactProducer,
	withArtifactActionLock,
} from "../artifact-store.ts";
import { createCacheLease } from "../cache-management.ts";
import { maligatorCacheDirectory } from "../cache-root.ts";
import { TEST262_METADATA } from "./constants.ts";
import { test262Log } from "./log.ts";

const CORPUS_PRODUCER = artifactProducer("test262-corpus", 1, "git-checkout");

export interface Test262Corpus {
	path: string;
	revision: string;
	tree: string;
	files: Array<string>;
}

interface CorpusOptions {
	cacheDirectory?: string;
	repository?: string;
	revision?: string;
}

function corpusLocation(options: CorpusOptions) {
	const cache = options.cacheDirectory ?? maligatorCacheDirectory();
	const revision = options.revision ?? TEST262_METADATA.revision;
	if (!/^[0-9a-f]{40}$/.test(revision))
		throw new Error("Test262 requires a pinned commit");
	return { cache, revision, directory: path.join(cache, "test262-corpora", revision) };
}

function git(directory: string, arguments_: Array<string>): string {
	return execFileSync(
		"git",
		["-c", "core.autocrlf=false", "-c", "core.fsmonitor=false", ...arguments_],
		{
			cwd: directory,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 16 * 1024 * 1024,
			timeout: 120_000,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
		},
	);
}

function inspectCorpus(directory: string, revision: string): Test262Corpus {
	if (!existsSync(path.join(directory, ".git"))) {
		throw new Error(
			`Test262 corpus is missing at ${directory}; run npm run test262:prepare`,
		);
	}
	const sha = git(directory, ["rev-parse", "HEAD"]).trim();
	if (sha !== revision) throw new Error(`Test262 corpus is ${sha}; expected ${revision}`);
	if (
		git(directory, [
			"status",
			"--porcelain=v1",
			"--untracked-files=all",
			"--ignored",
		]).trim() !== ""
	) {
		throw new Error(
			`Shared Test262 corpus is modified at ${directory}; restore the pinned contents before running tests`,
		);
	}
	const files = git(directory, [
		"ls-tree",
		"-r",
		"--name-only",
		"-z",
		"HEAD",
		"--",
		"test",
	])
		.split("\0")
		.filter((file) => file.endsWith(".js") && !file.endsWith("FIXTURE.js"))
		.sort();
	if (files.length === 0) throw new Error("Test262 corpus contains no tests");
	return {
		path: directory,
		revision,
		tree: git(directory, ["rev-parse", "HEAD^{tree}"]).trim(),
		files,
	};
}

/** Publish a pinned corpus once; existing snapshots are only validated, never checked out again. */
export function test262PrepareCheckout(options: CorpusOptions = {}): Test262Corpus {
	const { cache, directory, revision } = corpusLocation(options);
	const lease = createCacheLease("test262:prepare", cache);
	try {
		return withArtifactActionLock(
			cache,
			"test262-corpus",
			CORPUS_PRODUCER,
			artifactActionKey(CORPUS_PRODUCER, { revision }),
			() => {
				if (existsSync(directory)) return test262Checkout(options);
				mkdirSync(path.dirname(directory), { recursive: true });
				const temporary = mkdtempSync(path.join(path.dirname(directory), ".prepare-"));
				try {
					git(temporary, ["init", "--quiet"]);
					const repository =
						options.repository ?? `https://github.com/${TEST262_METADATA.repository}`;
					test262Log(`Fetching pinned revision ${revision}...`);
					git(temporary, ["fetch", "--depth", "1", repository, revision]);
					git(temporary, ["checkout", "--detach", "--quiet", revision]);
					const corpus = inspectCorpus(temporary, revision);
					renameSync(temporary, directory);
					return { ...corpus, path: directory };
				} finally {
					rmSync(temporary, { recursive: true, force: true });
				}
			},
		);
	} finally {
		lease.release();
	}
}

export function test262Checkout(options: CorpusOptions = {}): Test262Corpus {
	const { directory, revision } = corpusLocation(options);
	const corpus = inspectCorpus(directory, revision);
	const now = new Date();
	utimesSync(directory, now, now);
	test262Log(`Revision: ${revision}.`);
	return corpus;
}
