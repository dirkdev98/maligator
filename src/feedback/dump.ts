/** What one property inline cache held when its isolate stopped. */
export type FeedbackSiteValue =
	| { readonly shapes: ReadonlyArray<ReadonlyArray<string>> }
	| { readonly megamorphic: true }
	| { readonly mode: string };

export interface FeedbackDumpFunction {
	readonly functionIndex: number;
	readonly propertyIcCount: number;
	readonly sites: ReadonlyMap<number, FeedbackSiteValue>;
}

export interface FeedbackDump {
	/** Functions of the isolate's whole program: every spliced image, in splice order. */
	readonly functionCount: number;
	readonly functions: ReadonlyArray<FeedbackDumpFunction>;
}

const MAGIC = "MALFDB01";
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
	if (text(MAGIC.length) !== MAGIC) throw new Error("not a feedback dump");
	const version = u32();
	if (version !== 1) throw new Error(`unsupported feedback dump version ${version}`);
	const functionCount = u32();
	const recordCount = u32();
	const functions: Array<FeedbackDumpFunction> = [];
	for (let record = 0; record < recordCount; record++) {
		const functionIndex = u32();
		const propertyIcCount = u32();
		const siteCount = u32();
		const sites = new Map<number, FeedbackSiteValue>();
		for (let site = 0; site < siteCount; site++) {
			const icIndex = u32();
			const kind = u8();
			if (kind === 0) {
				const shapes: Array<Array<string>> = [];
				const shapeCount = u8();
				for (let shape = 0; shape < shapeCount; shape++) {
					const keys: Array<string> = [];
					const keyCount = u32();
					for (let key = 0; key < keyCount; key++) keys.push(text(u32()));
					shapes.push(keys);
				}
				sites.set(icIndex, { shapes });
			} else if (kind === 1) {
				sites.set(icIndex, { megamorphic: true });
			} else if (kind === 2) {
				sites.set(icIndex, { mode: text(u8()) });
			} else {
				throw new Error(`unknown feedback site kind ${kind}`);
			}
		}
		functions.push({ functionIndex, propertyIcCount, sites });
	}
	if (offset !== bytes.byteLength) throw new Error("feedback dump has trailing data");
	return { functionCount, functions };
}
