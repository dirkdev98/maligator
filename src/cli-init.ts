import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { writeFileAtomically } from "./atomic-file.ts";

export const BUILD_CONFIG_NAME = "maligator.build.ts";

const STARTER_ENTRY = "src/index.ts";
const CLI_TYPES = "@maligator/cli";
const ENTRY_CANDIDATES = [STARTER_ENTRY, "src/main.ts", "index.ts", "main.ts"];

class InitError extends Error {}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutJsonComments(source: string): string {
	// Keep offsets in the parsed copy so config edits preserve comments and formatting.
	return source
		.replace(/^\uFEFF/, " ")
		.replace(/"(?:\\[\s\S]|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (token) =>
			token.startsWith("/") ? token.replace(/[^\r\n]/g, " ") : token,
		)
		.replace(/"(?:\\[\s\S]|[^"\\])*"|,(?=\s*[}\]])/g, (token) =>
			token === "," ? " " : token,
		);
}

function propertyOffset(source: string, objectStart: number, name: string): number {
	let depth = 0;
	let offset = -1;
	for (const match of source
		.slice(objectStart)
		.matchAll(/"(?:\\[\s\S]|[^"\\])*"(?:\s*:)?|[{}[\]]/g)) {
		const token = match[0];
		if (token === "{" || token === "[") depth++;
		if (token === "}" || token === "]") depth--;
		if (depth === 0) break;
		if (depth === 1 && token.endsWith(":") && JSON.parse(token.slice(0, -1)) === name) {
			offset = objectStart + match.index + token.length;
			offset += source.slice(offset).search(/\S/);
		}
	}
	return offset;
}

function insertMember(
	source: string,
	containerStart: number,
	member: string,
	nonEmpty: boolean,
): string {
	const tail = source.slice(containerStart + 1);
	const layout = /^(?:\r?\n)?[\t ]*/.exec(tail)![0];
	// An empty multiline container has its closing delimiter at the parent indent.
	const indent = !nonEmpty && layout.includes("\n") ? `${layout}\t` : layout;
	const separator = nonEmpty ? (layout === "" ? ", " : ",") : "";
	return `${source.slice(0, containerStart + 1)}${indent}${member}${separator}${tail}`;
}

function addTypeScriptTypes(
	source: string,
	parsed: string,
	config: Record<string, unknown>,
): string | undefined {
	const options = config.compilerOptions;
	const type = JSON.stringify(CLI_TYPES);
	const objectStart = parsed.indexOf("{");
	if (options === undefined) {
		return insertMember(
			source,
			objectStart,
			`"compilerOptions": { "types": [${type}] }`,
			Object.keys(config).length > 0,
		);
	}
	if (!isJsonObject(options)) throw new InitError("compilerOptions must be an object");
	const optionsStart = propertyOffset(parsed, objectStart, "compilerOptions");
	const types = options.types;
	if (types === undefined) {
		return insertMember(
			source,
			optionsStart,
			`"types": [${type}]`,
			Object.keys(options).length > 0,
		);
	}
	if (!Array.isArray(types) || types.some((value) => typeof value !== "string")) {
		throw new InitError("compilerOptions.types must be an array of strings");
	}
	if (types.includes(CLI_TYPES)) return undefined;
	const typesStart = propertyOffset(parsed, optionsStart, "types");
	if (types.length === 0) return insertMember(source, typesStart, type, false);
	let lastTypeStart = typesStart;
	let lastTypeEnd = typesStart;
	for (const match of parsed.slice(typesStart).matchAll(/"(?:\\[\s\S]|[^"\\])*"|\]/g)) {
		if (match[0] === "]") break;
		lastTypeStart = typesStart + match.index;
		lastTypeEnd = lastTypeStart + match[0].length;
	}
	const indent =
		/(\r?\n[\t ]*)$/.exec(source.slice(typesStart, lastTypeStart))?.[1] ?? " ";
	return `${source.slice(0, lastTypeEnd)},${indent}${type}${source.slice(lastTypeEnd)}`;
}

export function initProject(cwd: string = process.cwd()): {
	entry: string;
	messages: Array<string>;
} {
	const messages: Array<string> = [];
	const create = (name: string, contents: string): void => {
		try {
			writeFileSync(path.join(cwd, name), contents, { flag: "wx" });
			messages.push(`Created ${name}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			messages.push(`Skipped ${name} (already exists)`);
		}
	};
	const edit = (
		name: string,
		defaults: string,
		update: (
			source: string,
			parsed: string,
			config: Record<string, unknown>,
		) => string | undefined,
	) => {
		const file = path.join(cwd, name);
		const stat = lstatSync(file, { throwIfNoEntry: false });
		if (stat === undefined) return create(name, defaults);
		if (!stat.isFile()) {
			messages.push(`Skipped ${name} (expected a regular file)`);
			return;
		}
		try {
			const source = readFileSync(file, "utf8");
			const parsed = name === "tsconfig.json" ? withoutJsonComments(source) : source;
			const config: unknown = JSON.parse(parsed);
			if (!isJsonObject(config)) throw new InitError("expected an object");
			const updated = update(source, parsed, config);
			if (updated === undefined) {
				messages.push(`Skipped ${name} (already configured)`);
			} else {
				writeFileAtomically(file, updated);
				messages.push(`Updated ${name}`);
			}
		} catch (error) {
			if (!(error instanceof SyntaxError || error instanceof InitError)) throw error;
			messages.push(`Skipped ${name} (${error.message})`);
		}
	};
	const entry = ENTRY_CANDIDATES.find((candidate) =>
		existsSync(path.join(cwd, candidate)),
	);
	if (entry === undefined) {
		mkdirSync(path.join(cwd, "src"), { recursive: true });
		create(STARTER_ENTRY, 'console.log("Hello, Maligator");\n');
	} else {
		messages.push(`Skipped ${entry} (already exists)`);
	}
	create(
		BUILD_CONFIG_NAME,
		`import { defineBuild } from "@maligator/cli";\n\nexport default defineBuild({\n\tentry: ${JSON.stringify(entry ?? STARTER_ENTRY)},\n});\n`,
	);
	edit("package.json", '{\n\t"type": "module"\n}\n', (source, parsed, config) =>
		Object.hasOwn(config, "type")
			? undefined
			: insertMember(
					source,
					parsed.indexOf("{"),
					'"type": "module"',
					Object.keys(config).length > 0,
				),
	);
	edit(
		"tsconfig.json",
		`${JSON.stringify(
			{
				compilerOptions: {
					target: "ESNext",
					module: "NodeNext",
					noEmit: true,
					allowImportingTsExtensions: true,
					types: [CLI_TYPES],
				},
			},
			null,
			"\t",
		)}\n`,
		addTypeScriptTypes,
	);
	return { entry: entry ?? STARTER_ENTRY, messages };
}
