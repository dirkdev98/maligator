import { hash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { maligatorCacheDirectory } from "../../src/cache-root.ts";
import { requireToolchain } from "../../src/toolchain.ts";

const runtime = path.resolve(import.meta.dirname, "../../runtime");

export function ffiResourceArrayCompilerEnvironment(
	environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const toolchain = requireToolchain({
		env: environment,
		rustDir: path.join(runtime, "rust"),
	});
	const cc = toolchain.tools.cc;
	const command = [cc.path, ...(cc.args ?? [])]
		.map((argument) => `'${argument.replaceAll("'", "'\\''")}'`)
		.join(" ");
	const source = `#!/bin/sh
for input do
	case "$input" in
		*/mal_ffi.c) set -- -Dcalloc=array_test_calloc "$@"; break ;;
	esac
done
exec ${command} "$@"
`;
	// Keep both backends on one toolchain and include the delegated compiler in its identity.
	const identity = hash("sha256", `${toolchain.ccFingerprint}\0${source}`);
	const directory = path.join(
		maligatorCacheDirectory(undefined, environment),
		"test",
		"ffi-resource-array-cc",
	);
	const wrapper = path.join(directory, identity);
	if (!existsSync(wrapper)) {
		mkdirSync(directory, { recursive: true });
		const temporary = mkdtempSync(path.join(directory, "publish-"));
		try {
			const staged = path.join(temporary, "cc");
			writeFileSync(staged, source, { mode: 0o755 });
			renameSync(staged, wrapper);
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	}
	return { ...environment, CC: wrapper };
}
