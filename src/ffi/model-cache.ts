import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	artifactActionKey,
	artifactDigest,
	artifactOutput,
	publishArtifactAction,
	readArtifactAction,
} from "../artifact-store.ts";
import { maligatorCacheDirectory } from "../cache-root.ts";
import { compilerProducerIdentity } from "../compiler-cache-identity.ts";
import { extractCModel } from "./c-extract.ts";
import type { CExtractionInput } from "./c-extract.ts";
import type { CModel } from "./c-model.ts";

const STAGE = "ffi-header-model";

interface CachedModel {
	/** Every file the headers read, with its content digest when the model was extracted. */
	readonly dependencies: ReadonlyArray<{
		readonly file: string;
		readonly digest: string;
	}>;
	readonly model: CModel;
}

function fileDigest(file: string): string | undefined {
	try {
		return artifactDigest(new Uint8Array(readFileSync(file)));
	} catch {
		return undefined;
	}
}

/** JSON for a model: maps become entry lists and bigints tagged strings. */
function encode(model: CModel): string {
	return JSON.stringify(model, (_key, value: unknown) =>
		value instanceof Map
			? { $map: [...(value as Map<unknown, unknown>).entries()] }
			: typeof value === "bigint"
				? { $bigint: value.toString() }
				: value,
	);
}

function decode(text: string): CachedModel {
	return JSON.parse(text, (_key, value: unknown) => {
		if (typeof value !== "object" || value === null) return value;
		if ("$map" in value)
			return new Map((value as { $map: Array<[unknown, unknown]> }).$map);
		if ("$bigint" in value) return BigInt((value as { $bigint: string }).$bigint);
		return value;
	}) as CachedModel;
}

/**
 * The C model of a library's headers, extracted once and reused until the
 * compiler, its arguments, the extractor, or any file the headers read changes.
 * The key cannot name the headers' dependencies before extraction, so each entry
 * records them and a lookup checks their contents.
 */
export function loadCModel(input: CExtractionInput): CModel {
	const compiler = statSync(input.compiler.path);
	const producer = compilerProducerIdentity(STAGE, 1);
	const key = artifactActionKey(producer, {
		compiler: {
			path: input.compiler.path,
			version: input.compiler.version,
			args: input.compiler.args ?? [],
			size: compiler.size,
			modified: compiler.mtimeMs,
		},
		headers: input.headers,
		compileArguments: input.compileArguments,
	});
	const root = maligatorCacheDirectory();
	const cached = readArtifactAction(root, STAGE, producer, key);
	if (cached !== undefined) {
		const entry = decode(readFileSync(artifactOutput(cached, "model.json").path, "utf8"));
		if (entry.dependencies.every(({ file, digest }) => fileDigest(file) === digest)) {
			return entry.model;
		}
	}
	const model = extractCModel(input);
	const dependencies = model.dependencies.flatMap((file) => {
		const digest = fileDigest(file);
		return digest === undefined ? [] : [{ file, digest }];
	});
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-model-"));
	try {
		const file = path.join(directory, "model.json");
		writeFileSync(
			file,
			`{"dependencies":${JSON.stringify(dependencies)},"model":${encode(model)}}`,
		);
		publishArtifactAction(root, STAGE, producer, key, [{ name: "model.json", file }]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
	return model;
}
