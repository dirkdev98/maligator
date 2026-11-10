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
import type { Test262CorpusComposition } from "./corpus-compositions.ts";
import { UNICODE18_CORPUS } from "./corpus-compositions.ts";
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
	composition?: Test262CorpusComposition;
}

function corpusLocation(options: CorpusOptions) {
	const cache = options.cacheDirectory ?? maligatorCacheDirectory();
	const revision = options.revision ?? TEST262_METADATA.revision;
	if (!/^[0-9a-f]{40}$/.test(revision))
		throw new Error("Test262 requires a pinned commit");
	return { cache, revision, directory: path.join(cache, "test262-corpora", revision) };
}

function git(directory: string, arguments_: Array<string>, input?: string): string {
	return execFileSync(
		"git",
		["-c", "core.autocrlf=false", "-c", "core.fsmonitor=false", ...arguments_],
		{
			cwd: directory,
			encoding: "utf8",
			stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			input,
			maxBuffer: 16 * 1024 * 1024,
			timeout: 120_000,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
		},
	);
}

interface TreeEntry {
	mode: string;
	type: string;
	object: string;
}

function readTree(directory: string, tree?: string): Map<string, TreeEntry> {
	const entries = new Map<string, TreeEntry>();
	if (tree === undefined) return entries;
	for (const record of git(directory, ["ls-tree", "-z", tree]).split("\0")) {
		if (record === "") continue;
		const separator = record.indexOf("\t");
		const [mode, type, object] = record.slice(0, separator).split(" ");
		entries.set(record.slice(separator + 1), {
			mode: mode!,
			type: type!,
			object: object!,
		});
	}
	return entries;
}

function writeTree(directory: string, entries: Map<string, TreeEntry>): string {
	return git(
		directory,
		["mktree", "-z"],
		Array.from(
			entries,
			([name, entry]) => `${entry.mode} ${entry.type} ${entry.object}\t${name}\0`,
		).join(""),
	).trim();
}

function mergeTrees(
	directory: string,
	base: string | undefined,
	generated: string,
): string {
	const entries = readTree(directory, base);
	for (const [name, entry] of readTree(directory, generated)) {
		const previous = entries.get(name);
		entries.set(name, {
			...entry,
			object:
				previous?.type === "tree" && entry.type === "tree"
					? mergeTrees(directory, previous.object, entry.object)
					: entry.object,
		});
	}
	return writeTree(directory, entries);
}

function overlayTree(
	directory: string,
	base: string | undefined,
	segments: Array<string>,
	generated: string,
): string {
	const [name, ...rest] = segments;
	if (name === undefined) return mergeTrees(directory, base, generated);
	const entries = readTree(directory, base);
	const previous = entries.get(name);
	if (previous !== undefined && previous.type !== "tree")
		throw new Error(`Test262 composition target is not a directory: ${name}`);
	entries.set(name, {
		mode: "040000",
		type: "tree",
		object: overlayTree(directory, previous?.object, rest, generated),
	});
	return writeTree(directory, entries);
}

function prepareComposition(directory: string, composition: Test262CorpusComposition) {
	for (const source of [composition.base, composition.generated]) {
		git(directory, ["fetch", "--depth", "1", source.repository, source.revision]);
		if (
			git(directory, ["rev-parse", `${source.revision}^{commit}`]).trim() !==
			source.revision
		)
			throw new Error("Test262 composition source is not the pinned commit");
	}
	let tree = git(directory, ["rev-parse", `${composition.base.revision}^{tree}`]).trim();
	for (const overlay of composition.overlays) {
		const sourceTree = git(directory, [
			"rev-parse",
			`${composition.generated.revision}:${overlay.source}`,
		]).trim();
		if (sourceTree !== overlay.tree)
			throw new Error(`Test262 composition source tree differs: ${overlay.source}`);
		tree = overlayTree(directory, tree, overlay.target.split("/"), sourceTree);
	}
	if (tree !== composition.tree)
		throw new Error("Test262 composed tree differs from its pin");
	const identity = `Corpus preparation <corpus@example.invalid> ${composition.epoch} +0000`;
	const commit = git(
		directory,
		["hash-object", "-t", "commit", "-w", "--stdin"],
		`tree ${tree}\nparent ${composition.base.revision}\nparent ${composition.generated.revision}\nauthor ${identity}\ncommitter ${identity}\n\n${composition.message}\n`,
	).trim();
	if (commit !== composition.revision)
		throw new Error("Test262 composed commit differs from its pin");
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
	const composition =
		options.composition ??
		(revision === UNICODE18_CORPUS.revision ? UNICODE18_CORPUS : undefined);
	if (composition !== undefined && composition.revision !== revision)
		throw new Error("Test262 composition does not match the requested revision");
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
					git(temporary, ["init", "--quiet", "--object-format=sha1"]);
					test262Log(`Fetching pinned revision ${revision}...`);
					if (composition !== undefined) prepareComposition(temporary, composition);
					else {
						const repository =
							options.repository ?? `https://github.com/${TEST262_METADATA.repository}`;
						git(temporary, ["fetch", "--depth", "1", repository, revision]);
					}
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
