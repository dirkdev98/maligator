import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileBuildFrontend } from "../src/build-frontend-cache.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";

it.each([
	{ target: "native", interpreted: false },
	{ target: "interpreted", interpreted: true },
])(
	"resolves platform imports in $target fragments from the installed source root",
	({ interpreted }) => {
		const root = mkdtempSync(path.join(tmpdir(), "mal-fragment-platform-sources-"));
		try {
			const files = {
				"entry.mjs": `import { installedFile } from "maligator:fs";
import { label } from "fixture";
import { suffix } from "./local.mjs";
console.log(label, installedFile(), suffix);
`,
				"local.mjs": 'export const suffix = "ready";\n',
				"node_modules/fixture/package.json": '{"exports":"./index.mjs"}\n',
				"node_modules/fixture/index.mjs": 'export const label = "platform";\n',
				"platform/fs/runtime.ts": 'export const installedFile = () => "installed";\n',
			};
			for (const [relative, source] of Object.entries(files)) {
				const file = path.join(root, relative);
				mkdirSync(path.dirname(file), { recursive: true });
				writeFileSync(file, source);
			}
			const built = compileBuildFrontend({
				entrypoint: path.join(root, "entry.mjs"),
				platformSourceRoot: path.join(root, "platform"),
				config: resolveBuildConfig({}),
				stripTypes: stripCompactTypes,
				stripperIdentity: "platform-fragment-sources",
				cacheDirectory: path.join(root, "cache"),
				optimization: "development",
				relocatable: true,
				interpreted,
			});
			expect(built.fragmentArtifacts?.misses).toBeGreaterThan(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);
