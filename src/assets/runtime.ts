import type {
	EmbedDirectoryOptions,
	EmbedFileOptions,
	EmbeddedDirectory,
	EmbeddedFile,
} from "maligator:assets";

// The compiler replaces every call of these exports with the handle it declares and
// rejects any other use of them, so a compiled program never reaches these bodies.
function undeclared(name: string): never {
	throw new TypeError(
		`${name} must be called directly with a string literal specifier and literal options`,
	);
}

export function embedFile(_specifier: string, _options?: EmbedFileOptions): EmbeddedFile {
	return undeclared("embedFile");
}

export function embedDirectory(
	_specifier: string,
	_options?: EmbedDirectoryOptions,
): EmbeddedDirectory {
	return undeclared("embedDirectory");
}
