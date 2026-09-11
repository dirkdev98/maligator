import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import {
	artifactActionKey,
	artifactDigest,
	artifactOutput,
	artifactProducer,
	publishArtifactAction,
	readArtifactAction,
	withArtifactActionLock,
} from "../artifact-store.ts";
import { maligatorCacheDirectory } from "../cache-root.ts";
import { hashDirectoryTrees } from "../file-tree.ts";
import type { Test262Corpus } from "./files.ts";
import { extractFrontmatterFromSource } from "./frontmatter.ts";
import { test262Log } from "./log.ts";
import type { Test262File, Test262Input } from "./types.ts";

const STAGE = "test262-input-index";

interface Test262InputIndex {
	schema: 1;
	revision: string;
	tree: string;
	files: Array<Test262Input>;
}

export function test262InputProducer(
	sourceRoot = path.resolve(import.meta.dirname, "../.."),
): string {
	const yamlRoot = path.dirname(
		createRequire(path.join(sourceRoot, "package.json")).resolve("yaml/package.json"),
	);
	return artifactProducer(
		STAGE,
		1,
		hashDirectoryTrees({
			root: yamlRoot,
			directories: [yamlRoot],
			include: (entry) => /\.(?:js|json)$/.test(entry.name),
			prefix: ["cache.ts", "frontmatter.ts", "types.ts"].flatMap((file) => [
				file,
				artifactDigest(readFileSync(path.join(sourceRoot, "src/test262", file))),
			]),
		}),
	);
}

function readInputIndex(
	file: string,
	corpus: Test262Corpus,
): Test262InputIndex | undefined {
	try {
		const index = JSON.parse(readFileSync(file, "utf8")) as Test262InputIndex;
		if (
			index.schema === 1 &&
			index.revision === corpus.revision &&
			index.tree === corpus.tree &&
			Array.isArray(index.files) &&
			index.files.length === corpus.files.length &&
			index.files.every(
				(input, i) =>
					input.path === corpus.files[i] &&
					/^[0-9a-f]{64}$/.test(input.sourceDigest) &&
					typeof input.frontmatter === "object" &&
					input.frontmatter !== null,
			)
		)
			return index;
	} catch {
		// Invalid or interrupted cache publications must be rebuilt from the pinned corpus.
	}
	return undefined;
}

export function test262LoadInputIndex(
	corpus: Test262Corpus,
	cache = maligatorCacheDirectory(),
	producer = test262InputProducer(),
): { files: Array<Test262Input>; cache: "hit" | "miss"; bytes: number } {
	const action = artifactActionKey(producer, {
		revision: corpus.revision,
		tree: corpus.tree,
	});
	return withArtifactActionLock(cache, STAGE, producer, action, () => {
		const cached = readArtifactAction(cache, STAGE, producer, action);
		if (cached !== undefined) {
			const output = artifactOutput(cached, "index.json");
			const index = readInputIndex(output.path, corpus);
			if (index !== undefined) {
				test262Log(`Using ${index.files.length} shared input records.`);
				return { files: index.files, cache: "hit", bytes: output.size };
			}
		}
		const files = corpus.files.map((file) => {
			const bytes = readFileSync(path.join(corpus.path, file));
			return {
				path: file,
				sourceDigest: artifactDigest(bytes),
				frontmatter: extractFrontmatterFromSource(file, bytes.toString("utf8"))
					.frontmatter,
			};
		});
		const index: Test262InputIndex = {
			schema: 1,
			revision: corpus.revision,
			tree: corpus.tree,
			files,
		};
		const work = path.join(cache, "work/test262-index");
		mkdirSync(work, { recursive: true });
		const directory = mkdtempSync(path.join(work, "index-"));
		try {
			const file = path.join(directory, "index.json");
			writeFileSync(file, JSON.stringify(index));
			const published = publishArtifactAction(cache, STAGE, producer, action, [
				{ name: "index.json", file },
			]);
			test262Log(`Indexed ${files.length} Test262 inputs in the shared cache.`);
			return {
				files,
				cache: "miss",
				bytes: artifactOutput(published, "index.json").size,
			};
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
}

export function test262LoadInputs(
	corpusRoot: string,
	inputs: ReadonlyArray<Test262Input>,
): Array<Test262File> {
	return inputs.map((input) => {
		const bytes = readFileSync(path.join(corpusRoot, input.path));
		if (artifactDigest(bytes) !== input.sourceDigest) {
			throw new Error(`Test262 input changed after indexing: ${input.path}`);
		}
		return {
			path: input.path,
			frontmatter: input.frontmatter,
			content: bytes.toString("utf8"),
			result: "UNKNOWN",
		};
	});
}
