import path from "node:path";

export function nativeSourcePath(file: string): string {
	return path.isAbsolute(file) ? path.relative(process.cwd(), file) : file;
}
