import { isPropertyKey, unwrapPropertyKey } from "../abstract-operations/property-map.ts";
import { toObject, toPropertyKey } from "../abstract-operations/type-conversion.ts";
import { EnvironmentRecord } from "../execution-contexts/environment-record.ts";
import { unwrapCompletion } from "./completion-record.ts";
import { EngineValue } from "./data-types.ts";

// TODO: Implement PrivateName class
class PrivateName {
	description: string;

	constructor(description: string) {
		this.description = description;
	}
}

// https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-reference-record-specification-type
export class ReferenceRecord {
	base: EngineValue | EnvironmentRecord | null;
	referencedName: EngineValue | string | PrivateName;
	strict: boolean;
	thisValue: EngineValue | null;

	constructor(props: Partial<ReferenceRecord>) {
		this.base = props.base ?? null;
		this.referencedName = props.referencedName ?? EngineValue.undefined();
		this.strict = props.strict ?? false;
		this.thisValue = props.thisValue ?? null;
	}

	// https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-ispropertyreference
	isPropertyReference(): boolean {
		if (this.base === null) {
			return false;
		}

		return !(this.base instanceof EnvironmentRecord);
	}

	getPropertyBase() {
		return this.base as EngineValue;
	}

	getEnvironmentRecordBase() {
		return this.base as EnvironmentRecord;
	}

	// https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-isunresolvablereference
	isUnresolvableReference() {
		return this.base === null;
	}

	// https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-issuperreference
	isSuperReference() {
		return this.thisValue !== null;
	}

	// https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-isprivatereference
	isPrivateReference() {
		return this.referencedName instanceof PrivateName;
	}

	// https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-getvalue
	getValue(): EngineValue {
		if (this.isUnresolvableReference()) {
			throw new ReferenceError(
				`Cannot access unresolvable reference ${JSON.stringify(this.referencedName)}`,
			);
		}

		if (this.isPropertyReference()) {
			const base = unwrapCompletion(toObject(this.base as EngineValue));
			if (this.isPrivateReference()) {
				//       i. Return ? PrivateGet(baseObj, V.[[ReferencedName]]).
				throw new Error("Not implemented. Needs PrivateGet support");
			}

			if (
				!isPropertyKey(this.referencedName) &&
				this.referencedName instanceof EngineValue
			) {
				this.referencedName = unwrapCompletion(toPropertyKey(this.referencedName));
			}

			return unwrapCompletion(
				base.objectGetInternalSlot("Get")(
					base,
					unwrapPropertyKey(this.referencedName),
					this.getThisValue(),
				),
			);
		}

		const base = this.base as EnvironmentRecord;
		return base.getBindingValue(
			unwrapPropertyKey(this.referencedName) as string,
			this.strict,
		);
	}

	// https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-putvalue
	putValue() {
		throw new Error(
			"Not implemented. Needs more logic for global object, private names, etc.",
		);
	}

	// https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-getthisvalue
	getThisValue() {
		return this.isSuperReference() ? this.thisValue! : (this.base as EngineValue);
	}

	// https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-initializereferencedbinding
	initializeReferencedBinding(W: EngineValue) {
		(this.base as EnvironmentRecord).initializeBinding(
			unwrapPropertyKey(this.referencedName) as string,
			W,
		);
	}

	// https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-makeprivatereference
	makePrivateReference(_description: string) {
		throw new Error(
			"Not implemented. Needs PrivateName and running execution context support",
		);
	}
}

export function getValue(ref: ReferenceRecord | EngineValue | undefined): EngineValue {
	if (ref === undefined) {
		throw new ReferenceError("Cannot access unresolvable reference undefined");
	}

	if (ref instanceof ReferenceRecord) {
		return ref.getValue();
	}

	return ref;
}
