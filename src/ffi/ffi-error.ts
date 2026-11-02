/** A user-facing FFI configuration, discovery, or extraction failure. */
export class FfiError extends Error {
	constructor(message: string) {
		super(message);
		Object.defineProperty(this, "name", { value: "FfiError", configurable: true });
	}
}

export class FfiSourceChangedError extends FfiError {
	readonly paths: Array<string>;
	constructor(paths: ReadonlyArray<string>) {
		super("library headers changed during analysis; rerun the command");
		this.paths = [...new Set(paths)].sort();
	}
}
