/** Program values a module derives from its own path, without a compiler host dependency. */

export function moduleFileUrl(filePath: string): string {
	const encoded = moduleFileUrlSuffix(filePath);
	return `file://${encoded.startsWith("/") ? "" : "/"}${encoded}`;
}

/**
 * Segment-wise encoding of a path, so the URL of `directory + suffix` is the URL
 * of `directory` followed by the encoded suffix when the suffix starts at a separator.
 */
export function moduleFileUrlSuffix(filePath: string): string {
	return filePath
		.replaceAll("\\", "/")
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

export function moduleDirname(filePath: string): string {
	const separator = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
	if (separator < 0) {
		return ".";
	}
	if (separator === 0) {
		return filePath[0]!;
	}
	if (separator === 2 && filePath[1] === ":") {
		return filePath.slice(0, 3);
	}
	return filePath.slice(0, separator);
}

export function isWithinDirectory(filePath: string, directory: string): boolean {
	if (!filePath.startsWith(directory)) return false;
	const next = filePath[directory.length];
	return next === undefined || next === "/" || next === "\\";
}

/**
 * Lowering for an image whose module paths under `directory` must stay unknown to
 * the optimizer: they are read from the `path` and `url` bindings that `module`
 * publishes from an earlier image, so the image can be rebased onto another location.
 */
export interface PackageRootLowering {
	readonly directory: string;
	readonly module: string;
}
