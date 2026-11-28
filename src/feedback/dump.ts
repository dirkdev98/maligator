/**
 * A shape's keys in slot order. A plain writable, enumerable, configurable data
 * property is its name; any other is `[name, flags]`, where flags lists the set
 * attributes from `w`, `e`, `c` and `a` (accessor) in that order.
 */
export type FeedbackShape = ReadonlyArray<string | readonly [string, string]>;

/**
 * The functions a site's loads produced or its calls called: 1 to 4 sorted
 * names (`builtin:<catalog id>` or `fn:<origin>:<revision>`), or megamorphic for
 * more, or for one without a portable name. Absent when no function was seen.
 */
export interface FeedbackTargets {
	readonly targets?: ReadonlyArray<string>;
	/** Set only without `targets`. */
	readonly targetsMegamorphic?: true;
}

/** What a property site's receivers showed, in the feedback file's terms. */
export type FeedbackPropertyValue =
	| { readonly shapes: ReadonlyArray<FeedbackShape>; readonly kind?: string }
	| {
			readonly mode: string;
			readonly shapes?: ReadonlyArray<FeedbackShape>;
			readonly kind?: string;
	  }
	| { readonly megamorphic: true }
	| { readonly dictionary: true };

/**
 * What one site observed: a property site's receivers and the functions it
 * loaded, or a `call` site's callees alone.
 */
export type FeedbackSiteValue = (FeedbackPropertyValue | Record<never, never>) &
	FeedbackTargets;

/** A function the runtime named: a VM function index, or a known primordial node. */
export interface FeedbackDumpTarget {
	readonly kind: "source" | "primordial";
	readonly index: number;
}

export interface FeedbackDumpTargets {
	readonly megamorphic: boolean;
	readonly targets: ReadonlyArray<FeedbackDumpTarget>;
}

/** One site of the runtime dump: everything its history and final row recorded. */
export interface FeedbackDumpSite {
	readonly megamorphic: boolean;
	readonly dictionary: boolean;
	/** Object receivers of more than one heap kind, or of one the runtime doesn't name. */
	readonly mixedKinds: boolean;
	/** The object receivers' heap kind; empty for ordinary objects or none. */
	readonly kind: string;
	/** The primitive receivers' type; empty for none. */
	readonly primitiveKind: string;
	/** Inline cache modes the site's row held; `own` is own data slots. */
	readonly modes: ReadonlyArray<string>;
	readonly shapes: ReadonlyArray<FeedbackShape>;
	/** The functions the site's loads produced. */
	readonly targets: FeedbackDumpTargets;
}

/** A plain call's callees, at a source position of a VM function's call instruction. */
export interface FeedbackDumpCall {
	readonly functionIndex: number;
	readonly position: number;
	readonly targets: FeedbackDumpTargets;
}

export interface FeedbackDumpFunction {
	readonly functionIndex: number;
	readonly propertyIcCount: number;
	readonly sites: ReadonlyMap<number, FeedbackDumpSite>;
}

export interface FeedbackDump {
	/** Functions of the isolate's whole program: every spliced image, in splice order. */
	readonly functionCount: number;
	/** Nodes of the runtime's primordial catalog, which primordial targets index. */
	readonly primordialCount: number;
	readonly functions: ReadonlyArray<FeedbackDumpFunction>;
	readonly calls: ReadonlyArray<FeedbackDumpCall>;
}

const MAGIC = "MALFDB03";
const VERSION = 3;
const TARGET_KINDS: ReadonlyArray<FeedbackDumpTarget["kind"] | undefined> = [
	undefined,
	"source",
	"primordial",
];
const MAX_SHAPES = 4;
const PLAIN_ATTRIBUTES = 0b0111;
const ATTRIBUTE_FLAGS: ReadonlyArray<readonly [number, string]> = [
	[1, "w"],
	[2, "e"],
	[4, "c"],
	[8, "a"],
];
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Read the raw dump written by runtime/src/feedback.c, whose header documents the layout. */
export function parseFeedbackDump(bytes: Uint8Array): FeedbackDump {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 0;
	const need = (count: number) => {
		if (offset + count > bytes.byteLength) throw new Error("feedback dump is truncated");
	};
	const u8 = () => {
		need(1);
		return view.getUint8(offset++);
	};
	const u32 = () => {
		need(4);
		const value = view.getUint32(offset, true);
		offset += 4;
		return value;
	};
	const text = (length: number) => {
		need(length);
		const value = decoder.decode(bytes.subarray(offset, offset + length));
		offset += length;
		return value;
	};
	const key = (): string | [string, string] => {
		const attributes = u8();
		const name = text(u32());
		if (attributes === PLAIN_ATTRIBUTES) return name;
		const flags = ATTRIBUTE_FLAGS.filter(([bit]) => (attributes & bit) !== 0)
			.map(([, flag]) => flag)
			.join("");
		return [name, flags];
	};
	const targets = (): FeedbackDumpTargets => {
		const megamorphic = (u8() & 1) !== 0;
		const list: Array<FeedbackDumpTarget> = [];
		for (let count = u8(); count > 0; count--) {
			const kind = TARGET_KINDS[u8()];
			const index = u32();
			if (kind === undefined) throw new Error("feedback dump has an unknown target kind");
			list.push({ kind, index });
		}
		return { megamorphic, targets: list };
	};
	if (text(MAGIC.length) !== MAGIC) throw new Error("not a feedback dump");
	const version = u32();
	if (version !== VERSION)
		throw new Error(`unsupported feedback dump version ${version}`);
	const functionCount = u32();
	const primordialCount = u32();
	const recordCount = u32();
	const functions: Array<FeedbackDumpFunction> = [];
	for (let record = 0; record < recordCount; record++) {
		const functionIndex = u32();
		const propertyIcCount = u32();
		const siteCount = u32();
		const sites = new Map<number, FeedbackDumpSite>();
		for (let site = 0; site < siteCount; site++) {
			const icIndex = u32();
			const flags = u8();
			const kind = text(u8());
			const primitiveKind = text(u8());
			const modes: Array<string> = [];
			for (let count = u8(); count > 0; count--) modes.push(text(u8()));
			const shapes: Array<FeedbackShape> = [];
			for (let count = u8(); count > 0; count--) {
				const keys: Array<string | [string, string]> = [];
				for (let keyCount = u32(); keyCount > 0; keyCount--) keys.push(key());
				shapes.push(keys);
			}
			sites.set(icIndex, {
				megamorphic: (flags & 1) !== 0,
				dictionary: (flags & 2) !== 0,
				mixedKinds: (flags & 4) !== 0,
				kind,
				primitiveKind,
				modes,
				shapes,
				targets: targets(),
			});
		}
		functions.push({ functionIndex, propertyIcCount, sites });
	}
	const calls: Array<FeedbackDumpCall> = [];
	for (let count = u32(); count > 0; count--) {
		const functionIndex = u32();
		const position = u32();
		calls.push({ functionIndex, position, targets: targets() });
	}
	if (offset !== bytes.byteLength) throw new Error("feedback dump has trailing data");
	return { functionCount, primordialCount, functions, calls };
}

/**
 * The value a site's observations make. Several modes, or own slots and a mode,
 * are megamorphic, as is a dictionary receiver mixed with anything else. So is a
 * site whose cache never held a mode: the runtime declined to cache its accesses.
 */
export function feedbackPropertyValue(site: FeedbackDumpSite): FeedbackPropertyValue {
	if (site.megamorphic || site.mixedKinds || site.modes.length > 1)
		return { megamorphic: true };
	if (site.dictionary)
		return site.shapes.length === 0 && site.modes.length === 0
			? { dictionary: true }
			: { megamorphic: true };
	const [mode] = site.modes;
	if (mode === undefined || site.shapes.length > MAX_SHAPES) return { megamorphic: true };
	// The runtime flags primitive and object receivers together as mixed kinds.
	const receiverKind = site.primitiveKind === "" ? site.kind : site.primitiveKind;
	const kind = receiverKind === "" ? {} : { kind: receiverKind };
	if (mode !== "own")
		return {
			mode,
			...(site.shapes.length === 0 ? {} : { shapes: site.shapes }),
			...kind,
		};
	return site.shapes.length === 0
		? { megamorphic: true }
		: { shapes: site.shapes, ...kind };
}
