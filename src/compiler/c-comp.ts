import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Transform } from "./transform.ts";

export function doCCompile(transformer: Transform) {
	const baseDir = path.join(import.meta.dirname, "../../.cache/tmp-output");
	const runtimeDir = path.join(import.meta.dirname, "../../runtime");
	const runtimeBuildDir = path.join(runtimeDir, "cmake-build-debug");
	const runtimeIncludeDir = path.join(runtimeDir, "src");
	const runtimeLibraryPath = path.join(runtimeBuildDir, "libLibMaligator.a");
	const outputPath = path.join(baseDir, "program");

	if (!fs.existsSync(runtimeLibraryPath)) {
		throw new Error(
			`LibMaligator was not found at ${runtimeLibraryPath}. Build runtime/ first.`,
		);
	}

	fs.rmSync(baseDir, { recursive: true, force: true });
	fs.mkdirSync(baseDir, { recursive: true });

	const chunkFilePaths: Array<string> = [];
	for (const [key, value] of Object.entries(transformer.chunks)) {
		const filename = `${key}.c`;
		const filePath = path.join(baseDir, filename);
		fs.writeFileSync(filePath, value, "utf8");
		chunkFilePaths.push(filePath);
	}

	// Declare all declarations since we don't emit header files.
	const chunkInitDeclarations = [...transformer.chunkInits]
		.map((it) => `void ${it}(MalThread *thread, MalEnv *env);`)
		.join("\n");
	const chunkEntrypointDeclarations = [...transformer.chunkEntrypoint]
		.map((it) => `void ${it}(MalThread *thread, MalEnv *env);`)
		.join("\n");

	const chunkInitCalls = [...transformer.chunkInits]
		.map((it) => `  ${it}(&thread, &env);`)
		.join("\n");
	const chunkEntrypointCalls = [...transformer.chunkEntrypoint]
		.map((it) => `  ${it}(&thread, &env);`)
		.join("\n");

	const main = `
${Transform.includes()}

	${chunkInitDeclarations}
	${chunkEntrypointDeclarations}

	int main(void) {
	    MalThread thread = {0};
	    MalEnv env = {0};
	    (void)env;
	    
	    mal_thread_init(&thread);

	${chunkInitCalls}
	${chunkEntrypointCalls}

	    mal_value_debug(thread.return_value);
	    printf("\\n");

	    if (thread.return_result == MAL_NORMAL) {
	        return 0;
	    }

	    return 1;
	}
	`;

	const mainPath = path.join(baseDir, "main.c");
	fs.writeFileSync(mainPath, main, "utf8");

	const runtimeBuildResult = spawnSync(
		"cmake",
		["--build", runtimeBuildDir, "--target", "LibMaligator"],
		{ encoding: "utf8" },
	);

	if (runtimeBuildResult.error) {
		throw runtimeBuildResult.error;
	}

	if (runtimeBuildResult.status !== 0) {
		if (runtimeBuildResult.stdout) {
			process.stdout.write(runtimeBuildResult.stdout);
		}

		if (runtimeBuildResult.stderr) {
			process.stderr.write(runtimeBuildResult.stderr);
		}

		throw new Error(
			`LibMaligator rebuild exited with status ${runtimeBuildResult.status ?? "unknown"}`,
		);
	}

	const result = spawnSync(
		"clang",
		[
			"-std=c2x",
			"-I",
			runtimeIncludeDir,
			...chunkFilePaths,
			mainPath,
			runtimeLibraryPath,
			"-o",
			outputPath,
		],
		{ stdio: "inherit" },
	);

	if (result.error) {
		throw result.error;
	}

	if (result.status !== 0) {
		throw new Error(`clang exited with status ${result.status ?? "unknown"}`);
	}

	return outputPath;
}
