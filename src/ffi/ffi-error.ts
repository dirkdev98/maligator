/** A user-facing FFI configuration, discovery, or extraction failure. */
export class FfiError extends Error {
	constructor(message: string) {
		super(message);
		Object.defineProperty(this, "name", { value: "FfiError", configurable: true });
	}
}
