import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { expect, it } from "vitest";
import { TEMPORAL_INSTALLER } from "../src/compiler/frontend/engine-components.ts";
import {
	HOST_PERSONALITY_INSTALLER,
	hostInstallerSymbol,
	WEB_FETCH_INSTALLER,
} from "../src/compiler/frontend/host-modules.ts";
import {
	imageUsesUrlParser,
	resolveNativeHostFeatures,
} from "../src/native-host-components.ts";

const plainServer = [
	HOST_PERSONALITY_INSTALLER,
	hostInstallerSymbol("maligator:internal/http"),
	WEB_FETCH_INSTALLER,
].map((installer) => ({ installer, exports: [] }));

it("omits ring for a plaintext server with fetch data classes", () => {
	expect(resolveNativeHostFeatures([plainServer]).usesTlsOrCrypto).toBe(false);
});

it.each(["node:tls", "node:constants", "maligator:internal/fetch"])(
	"retains ring for a worker that uses %s",
	(specifier) => {
		const worker = [{ installer: hostInstallerSymbol(specifier), exports: [] }];
		expect(resolveNativeHostFeatures([plainServer, worker]).usesTlsOrCrypto).toBe(true);
	},
);

it("retains ring for drivers that resolve installers by name", () => {
	expect(resolveNativeHostFeatures([], true).usesTlsOrCrypto).toBe(true);
});

it.each([
	hostInstallerSymbol("node:tls"),
	hostInstallerSymbol("node:crypto"),
	TEMPORAL_INSTALLER,
])("retains the full Rust archive for %s", (installer) => {
	expect(resolveNativeHostFeatures([[{ installer, exports: [] }]]).usesRustStd).toBe(
		true,
	);
});

function withoutCommentsAndLiterals(source: string): string {
	return source.replaceAll(
		/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g,
		" ",
	);
}

it("selects Ada for installers in C translation units that reference its ABI", () => {
	const runtime = path.resolve(import.meta.dirname, "../runtime");
	const header = withoutCommentsAndLiterals(
		readFileSync(path.join(runtime, "rust/include/mal_url.h"), "utf8"),
	);
	const symbols = new Set(
		Array.from(header.matchAll(/\bmal_url_\w+(?=\s*\()/g), ([symbol]) => symbol),
	);
	expect(symbols.size).toBeGreaterThan(0);

	const missing: Array<string> = [];
	const sources = readdirSync(path.join(runtime, "src"), {
		recursive: true,
		withFileTypes: true,
	});
	for (const entry of sources) {
		if (!entry.isFile() || !entry.name.endsWith(".c")) continue;
		const file = path.join(entry.parentPath, entry.name);
		const source = withoutCommentsAndLiterals(readFileSync(file, "utf8"));
		const referencesAda = source
			.match(/\b(?:mal_url|ada)_\w+\b/g)
			?.some((symbol) => symbols.has(symbol) || symbol.startsWith("ada_"));
		if (!referencesAda) continue;

		const installers = [
			...Array.from(
				source.matchAll(/\bvoid\s+(mal_host_install_\w+)\s*\([^)]*\)\s*\{/g),
				(match) => match[1]!,
			),
			...Array.from(
				source.matchAll(/^MAL_WEB_GROUP_DEFINE\(\s*(\w+)\s*,/gm),
				(match) => `mal_host_install_web_${match[1]}`,
			),
		];
		const relative = path.relative(runtime, file);
		if (installers.length === 0) {
			missing.push(`${relative} needs its Ada callers covered`);
		}
		for (const installer of installers) {
			if (!imageUsesUrlParser([{ installer, exports: [] }])) {
				missing.push(`${relative}:${installer}`);
			}
		}
	}
	expect(missing.sort()).toEqual([]);
});
