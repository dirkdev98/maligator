export function parseTest262Manifest(contents: string): Set<string> {
	const entries = contents
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
	const paths = new Set(entries);
	if (paths.size === 0) {
		throw new Error("Test262 manifest must contain at least one path");
	}
	if (paths.size !== entries.length) {
		throw new Error("Test262 manifest contains duplicate paths");
	}
	return paths;
}

export function mergeTest262Manifests(
	manifests: ReadonlyArray<ReadonlySet<string>>,
): Set<string> {
	const merged = new Set<string>();
	for (const manifest of manifests) {
		for (const testPath of manifest) {
			if (merged.has(testPath)) {
				throw new Error(`Test262 manifests overlap at ${testPath}`);
			}
			merged.add(testPath);
		}
	}
	return merged;
}

function assertManifestPaths(
	paths: ReadonlySet<string>,
	corpusPaths: ReadonlySet<string>,
	label: string,
) {
	const missing = [...paths].filter((path) => !corpusPaths.has(path));
	if (missing.length > 0) {
		const samples = missing.slice(0, 10).join(", ");
		throw new Error(
			`${label} contains ${missing.length} path${missing.length === 1 ? "" : "s"} not in the Test262 corpus: ${samples}`,
		);
	}
}

export function selectTest262ManifestFiles<T extends { path: string }>(
	files: ReadonlyArray<T>,
	include: ReadonlySet<string> | undefined,
	exclude: ReadonlySet<string> | undefined,
): Array<T> {
	const corpusPaths = new Set(files.map((file) => file.path));
	if (include) {
		assertManifestPaths(include, corpusPaths, "Include manifest");
	}
	if (exclude) {
		assertManifestPaths(exclude, corpusPaths, "Exclude manifest");
	}
	return files.filter(
		(file) => (!include || include.has(file.path)) && !exclude?.has(file.path),
	);
}
