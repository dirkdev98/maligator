export class BuildConfigError extends Error {
	constructor(message: string) {
		super(message);
		Object.defineProperty(this, "name", {
			value: "BuildConfigError",
			configurable: true,
		});
	}
}
