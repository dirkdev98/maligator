import * as path from "node:path";

/** Replace checkout-specific runtime paths in native action inputs. */
export function normalizeRuntimeBuildArgument(
	runtimeDirectory: string,
	argument: string,
): string {
	const prefix = `-ffile-prefix-map=${runtimeDirectory}=`;
	if (argument.startsWith(prefix)) {
		return `-ffile-prefix-map=<runtime>=${argument.slice(prefix.length)}`;
	}
	const relative = path.relative(runtimeDirectory, argument);
	if (relative === "") return "<runtime>";
	if (
		!relative.startsWith(`..${path.sep}`) &&
		relative !== ".." &&
		!path.isAbsolute(relative)
	) {
		return path.posix.join("<runtime>", ...relative.split(path.sep));
	}
	return argument;
}
