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

/**
 * What is wrong with a contract fact: it names something the headers do not declare,
 * conflicts with another fact or export, does not apply to its C declaration or
 * position, or applies but misses a requirement of the declaration or other facts.
 */
export type FfiFactCode =
	| "unknown-name"
	| "conflict"
	| "inapplicable"
	| "unmet-requirement";

const FACT_SECTIONS = /^(?:types|functions|globals)\./;

/** A contract fact the binding planner rejected, located by its dotted fact path. */
export class FfiFactError extends FfiError {
	readonly code: FfiFactCode;
	/**
	 * The fact at fault, from its `types`, `functions` or `globals` section. Value
	 * mapping states paths relative to the fact it maps until a caller places them.
	 */
	readonly path: string;
	readonly detail: string;
	/** The fact whose planning reached a fault in another, such as a function using a type. */
	readonly context?: string;

	constructor(code: FfiFactCode, path: string, detail: string, context?: string) {
		super(
			[context, path === "" ? undefined : path, detail]
				.filter((part) => part !== undefined)
				.join(": "),
		);
		this.code = code;
		this.path = path;
		this.detail = detail;
		if (context !== undefined) this.context = context;
	}

	get absolute(): boolean {
		return FACT_SECTIONS.test(this.path);
	}

	/** The section and name of the contract entry that holds the fact, when placed. */
	get entry(): { readonly section: string; readonly name: string } | undefined {
		return factEntry(this.path);
	}

	/** Place a relative path below `fact`, or record `fact` as context for a placed one. */
	under(fact: string): FfiFactError {
		if (!this.absolute)
			return new FfiFactError(
				this.code,
				this.path === "" ? fact : `${fact}.${this.path}`,
				this.detail,
			);
		return this.context === undefined
			? new FfiFactError(this.code, this.path, this.detail, fact)
			: this;
	}
}

/** The section and name of the contract entry a dotted fact path starts in. */
export function factEntry(
	path: string,
): { readonly section: string; readonly name: string } | undefined {
	if (!FACT_SECTIONS.test(path)) return undefined;
	const [section, name] = path.split(".", 2) as [string, string];
	return { section, name };
}
