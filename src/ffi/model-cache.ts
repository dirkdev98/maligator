import type { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
import { writeSourceChunks } from "../generated-source.ts";
import { extractCModel } from "./c-extract.ts";
import type { CExtractionInput } from "./c-extract.ts";
import type { CEnum, CModel, CRecord, CTypedef } from "./c-model.ts";

const STAGE = "ffi-header-model";

/**
 * Variables that change which headers clang reads without changing its arguments:
 * include search paths, and the SDK and deployment target on Apple platforms.
 */
const HEADER_ENVIRONMENT = [
	"CPATH",
	"C_INCLUDE_PATH",
	"OBJC_INCLUDE_PATH",
	"SDKROOT",
	"DEVELOPER_DIR",
	"MACOSX_DEPLOYMENT_TARGET",
] as const;

interface Dependency {
	readonly file: string;
	readonly digest: string;
}

interface CachedModel {
	/** Every file the headers read, with its content digest when the model was extracted. */
	readonly dependencies: ReadonlyArray<Dependency>;
	readonly model: CModel;
}

function fileDigest(file: string): string | undefined {
	try {
		return artifactDigest(new Uint8Array(readFileSync(file)));
	} catch {
		return undefined;
	}
}

type CachedRow =
	| ["target", CModel["target"]]
	| ["header", CModel["headers"][number]]
	| ["file", string]
	| ["dependency", Dependency]
	| ["function", CModel["functions"][number]]
	| ["record", CRecord]
	| ["enum", CEnum]
	| ["typedef", CTypedef]
	| ["macro", CModel["macros"][number]]
	| ["untypedMacro", CModel["untypedMacros"][number]];

/** Each row fits independently; the aggregate model never becomes one engine string. */
function* encode(
	model: CModel,
	dependencies: ReadonlyArray<Dependency>,
): Generator<string> {
	for (const [kind, entries] of [
		["target", [model.target]],
		["header", model.headers],
		["file", model.files],
		["dependency", dependencies],
		["function", model.functions],
		["record", model.records.values()],
		["enum", model.enums.values()],
		["typedef", model.typedefs.values()],
		["macro", model.macros],
		["untypedMacro", model.untypedMacros],
	] as const) {
		for (const entry of entries) {
			yield JSON.stringify([kind, entry], (_key, value: unknown) =>
				typeof value === "bigint" ? { $bigint: value.toString() } : value,
			);
			yield "\n";
		}
	}
}

function decode(data: Buffer): CachedModel {
	let target: CModel["target"] | undefined;
	const headers: Array<CModel["headers"][number]> = [];
	const files: Array<string> = [];
	const dependencies: Array<Dependency> = [];
	const functions: Array<CModel["functions"][number]> = [];
	const records = new Map<string, CRecord>();
	const enums = new Map<string, CEnum>();
	const typedefs = new Map<string, CTypedef>();
	const macros: Array<CModel["macros"][number]> = [];
	const untypedMacros: Array<CModel["untypedMacros"][number]> = [];
	for (let start = 0; start < data.length;) {
		let end = data.indexOf(10, start);
		if (end < 0) end = data.length;
		const row = JSON.parse(data.toString("utf8", start, end), (_key, value: unknown) => {
			if (typeof value === "object" && value !== null && "$bigint" in value)
				return BigInt((value as { $bigint: string }).$bigint);
			return value;
		}) as CachedRow;
		start = end + 1;
		switch (row[0]) {
			case "target":
				target = row[1];
				break;
			case "header":
				headers.push(row[1]);
				break;
			case "file":
				files.push(row[1]);
				break;
			case "dependency":
				dependencies.push(row[1]);
				break;
			case "function":
				functions.push(row[1]);
				break;
			case "record":
				records.set(row[1].name, row[1]);
				break;
			case "enum":
				enums.set(row[1].name, row[1]);
				break;
			case "typedef":
				typedefs.set(row[1].name, row[1]);
				break;
			case "macro":
				macros.push(row[1]);
				break;
			case "untypedMacro":
				untypedMacros.push(row[1]);
				break;
		}
	}
	if (target === undefined) throw new Error("cached C model has no target");
	return {
		dependencies,
		model: {
			target,
			headers,
			files,
			dependencies: dependencies.map(({ file }) => file),
			functions,
			records,
			enums,
			typedefs,
			macros,
			untypedMacros,
		},
	};
}

/**
 * The C model of a library's headers, extracted once and reused until the
 * compiler, its arguments, the extractor, or any file the headers read changes.
 * The key cannot name the headers' dependencies before extraction, so each entry
 * records them and a lookup checks their contents.
 */
export function loadCModel(input: CExtractionInput): CModel {
	const compiler = statSync(input.compiler.path);
	const producer = compilerProducerIdentity(STAGE, 2);
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
		environment: HEADER_ENVIRONMENT.map((name) => [
			name,
			input.environment[name] ?? null,
		]),
	});
	const root = maligatorCacheDirectory();
	const cached = readArtifactAction(root, STAGE, producer, key);
	if (cached !== undefined) {
		const entry = decode(readFileSync(artifactOutput(cached, "model.jsonl").path));
		if (entry.dependencies.every(({ file, digest }) => fileDigest(file) === digest)) {
			return entry.model;
		}
	}
	const model = extractCModel(input);
	const dependencies: Array<Dependency> = [];
	for (const file of model.dependencies) {
		const digest = fileDigest(file);
		if (digest === undefined) return model;
		dependencies.push({ file, digest });
	}
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-model-"));
	try {
		const file = path.join(directory, "model.jsonl");
		writeSourceChunks(file, encode(model, dependencies));
		publishArtifactAction(root, STAGE, producer, key, [{ name: "model.jsonl", file }]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
	return model;
}
