import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { BuildConfigError } from "../build-config-error.ts";
import type {
	BuildConfigTypeStripper,
	Leaf,
	ObjectSchema,
} from "../definition-module.ts";
import {
	SchemaViolation,
	evaluateDefinitionModule,
	expect,
	expectKeys,
	expectObject,
	validateDefinition,
} from "../definition-module.ts";
import type {
	MaligatorFfiFind,
	MaligatorFfiLibrary,
	MaligatorLibraryContract,
} from "../public-api.d.ts";

/** Library names become module specifiers (`maligator:ffi/<name>`) and C identifiers. */
const LIBRARY_NAME = /^[a-z][a-z0-9_]*$/;

const FIND_KEYS = [
	"pkgConfig",
	"includeDirs",
	"defines",
	"libraryDirs",
	"libraries",
	"frameworks",
	"sources",
] as const;

function nonEmptyStringArray(value: unknown, at: string): void {
	expect(
		Array.isArray(value) &&
			value.every((item) => typeof item === "string" && item.length > 0),
		at,
		"an array of non-empty strings",
	);
}

function validateFind(value: unknown, at: string): void {
	expectObject(value, at);
	expectKeys(value, at, FIND_KEYS);
	if (value.pkgConfig !== undefined) {
		expect(
			typeof value.pkgConfig === "string" && value.pkgConfig.length > 0,
			`${at}.pkgConfig`,
			"a non-empty string",
		);
	}
	for (const key of [
		"includeDirs",
		"libraryDirs",
		"libraries",
		"frameworks",
		"sources",
	]) {
		if (value[key] !== undefined) nonEmptyStringArray(value[key], `${at}.${key}`);
	}
	if (value.defines !== undefined) {
		const defines = value.defines;
		expect(
			typeof defines === "object" &&
				defines !== null &&
				!Array.isArray(defines) &&
				Object.entries(defines).every(
					([name, definition]) =>
						/^[A-Za-z_]\w*$/.test(name) && typeof definition === "string",
				),
			`${at}.defines`,
			"a record of macro names to string values",
		);
	}
	if (
		value.pkgConfig === undefined &&
		value.libraries === undefined &&
		value.sources === undefined
	) {
		throw new SchemaViolation(`'${at}' must name pkgConfig, libraries, or sources`);
	}
}

/** The build config's `ffi` field: library names mapped to their contracts. */
export const ffiLibrariesLeaf: Leaf = {
	leaf: (value, at) => {
		expectObject(value, at);
		for (const [name, entry] of Object.entries(value)) {
			const entryAt = `${at}.${name}`;
			expect(
				LIBRARY_NAME.test(name),
				entryAt,
				"named by lowercase letters, digits, and _",
			);
			expectObject(entry, entryAt);
			expectKeys(entry, entryAt, ["contract", "find", "link"]);
			expect(
				typeof entry.contract === "string" && entry.contract.length > 0,
				`${entryAt}.contract`,
				"a non-empty string",
			);
			if (entry.find !== undefined) validateFind(entry.find, `${entryAt}.find`);
			if (entry.link !== undefined) {
				expect(
					entry.link === "static" || entry.link === "shared",
					`${entryAt}.link`,
					`"static" or "shared"`,
				);
			}
		}
	},
};

const CONTRACT_SCHEMA: ObjectSchema = {
	object: {
		headers: {
			leaf: (value, at) => {
				nonEmptyStringArray(value, at);
				expect((value as Array<string>).length > 0, at, "a non-empty array");
				for (const header of value as Array<string>) {
					expect(
						!/["\n\\]/.test(header),
						at,
						"header names without quotes or backslashes",
					);
				}
			},
		},
		find: {
			leaf: (value, at) => {
				expect(Array.isArray(value), at, "an array");
				(value as Array<unknown>).forEach((entry, index) =>
					validateFind(entry, `${at}[${index}]`),
				);
			},
		},
	},
};

/** A discovery description with paths made absolute against its declaring file. */
export interface ResolvedFind {
	readonly pkgConfig?: string;
	readonly includeDirs: ReadonlyArray<string>;
	readonly defines: Readonly<Record<string, string>>;
	readonly libraryDirs: ReadonlyArray<string>;
	readonly libraries: ReadonlyArray<string>;
	readonly frameworks: ReadonlyArray<string>;
	readonly sources: ReadonlyArray<string>;
}

export function resolveFind(find: MaligatorFfiFind, baseDirectory: string): ResolvedFind {
	const absolute = (paths: ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
		(paths ?? []).map((entry) => path.resolve(baseDirectory, entry));
	return {
		...(find.pkgConfig === undefined ? {} : { pkgConfig: find.pkgConfig }),
		includeDirs: absolute(find.includeDirs),
		defines: { ...find.defines },
		libraryDirs: absolute(find.libraryDirs),
		libraries: [...(find.libraries ?? [])],
		frameworks: [...(find.frameworks ?? [])],
		sources: absolute(find.sources),
	};
}

export interface LibraryContract {
	readonly name: string;
	readonly path: string;
	readonly headers: ReadonlyArray<string>;
	/** Discovery alternatives in order: the build config's override, else the contract's. */
	readonly find: ReadonlyArray<ResolvedFind>;
	readonly link: "static" | "shared" | undefined;
}

/**
 * Load the contract a build config names for `name`. Contract paths resolve against
 * the project root; paths inside a contract resolve against the contract's directory.
 */
export function loadLibraryContract(
	name: string,
	library: MaligatorFfiLibrary,
	projectRoot: string,
	stripTypes: BuildConfigTypeStripper,
): LibraryContract {
	const contractPath = path.resolve(projectRoot, library.contract);
	const label = path.relative(projectRoot, contractPath) || contractPath;
	if (!existsSync(contractPath)) {
		throw new BuildConfigError(`ffi.${name}.contract: file not found: ${contractPath}`);
	}
	const value = evaluateDefinitionModule(
		readFileSync(contractPath, "utf-8"),
		contractPath,
		{ label, helper: "defineLibrary", noun: "contract" },
		stripTypes,
	);
	validateDefinition(value, CONTRACT_SCHEMA, label);
	const contract = value as MaligatorLibraryContract;
	if (contract.headers === undefined) {
		throw new BuildConfigError(`${label}: 'headers' is required`);
	}
	const find =
		library.find !== undefined
			? [resolveFind(library.find, projectRoot)]
			: (contract.find ?? []).map((entry) =>
					resolveFind(entry, path.dirname(contractPath)),
				);
	if (find.length === 0) {
		throw new BuildConfigError(
			`ffi.${name}: neither the build config nor ${label} says how to find the library`,
		);
	}
	return {
		name,
		path: contractPath,
		headers: [...contract.headers],
		find,
		link: library.link,
	};
}
