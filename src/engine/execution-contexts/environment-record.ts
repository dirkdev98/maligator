import { isNil } from "../../utils.ts";
import {
	definePropertyOrThrow,
	get,
	hasOwnProperty,
	hasProperty,
	set,
} from "../abstract-operations/object-operations.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import { isExtensible } from "../abstract-operations/testing-and-comparison.ts";
import { toBoolean } from "../abstract-operations/type-conversion.ts";
import { unwrapCompletion } from "../types-and-values/completion-record.ts";
import { EngineValue, WELL_KNOWN_SYMBOLS } from "../types-and-values/data-types.ts";

export abstract class EnvironmentRecord {
	outerEnv: EnvironmentRecord | null = null;

	abstract hasBinding(name: string): boolean;

	abstract createMutableBinding(name: string, deletable?: boolean): void;

	abstract createImmutableBinding(name: string, strict: boolean): void;

	abstract initializeBinding(name: string, value: EngineValue): void;

	abstract setMutableBinding(name: string, value: EngineValue, strict?: boolean): void;

	abstract getBindingValue(name: string, strict?: boolean): EngineValue;

	abstract deleteBinding(name: string): boolean;

	abstract hasThisBinding(): boolean;

	abstract hasSuperBinding(): boolean;

	abstract withBaseObject(): EngineValue;
}

// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-declarative-environment-records
export class DeclarativeEnvironmentRecord extends EnvironmentRecord {
	private bindings: Record<
		string,
		{
			value?: EngineValue | undefined;
			immutable?: true;
			strict?: true;
			deletable: boolean;
		}
	> = {};

	constructor() {
		super();
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-declarative-environment-records-hasbinding-n
	override hasBinding(name: string): boolean {
		return !isNil(this.bindings[name]);
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-declarative-environment-records-createmutablebinding-n-d
	override createMutableBinding(name: string, deletable?: boolean): void {
		this.bindings[name] = {
			deletable: deletable ?? false,
		};
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-declarative-environment-records-createimmutablebinding-n-s
	override createImmutableBinding(name: string, strict: boolean): void {
		this.bindings[name] = {
			value: undefined,
			strict: strict ? true : undefined,
			immutable: true,
			deletable: false,
		};
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-declarative-environment-records-initializebinding-n-v
	override initializeBinding(name: string, value: EngineValue): void {
		const binding = this.bindings[name]!;
		binding.value = value;
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-declarative-environment-records-setmutablebinding-n-v-s
	override setMutableBinding(name: string, value: EngineValue, strict?: boolean): void {
		const binding = this.bindings[name];

		if (isNil(binding)) {
			if (strict) {
				throw new ReferenceError(`Binding for ${name} does not exist.`);
			}

			this.createMutableBinding(name, true);
			this.initializeBinding(name, value);
			return;
		}

		if (binding.strict) {
			strict = true;
		}

		if (isNil(binding.value)) {
			throw new ReferenceError(`Binding for ${name} has not been initialized.`);
		} else if (binding.immutable !== true) {
			binding.value = value;
		} else {
			if (strict) {
				throw new TypeError(`Cannot change the value of an immutable binding.`);
			}
		}
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-declarative-environment-records-getbindingvalue-n-s
	override getBindingValue(name: string, _strict?: boolean): EngineValue {
		const binding = this.bindings[name];
		if (isNil(binding?.value)) {
			throw new ReferenceError(`Binding for ${name} has not been initialized.`);
		}

		return binding.value;
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-declarative-environment-records-deletebinding-n
	override deleteBinding(name: string): boolean {
		const binding = this.bindings[name]!;
		if (!binding.deletable) {
			return false;
		}

		delete this.bindings[name];
		return true;
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-declarative-environment-records-hasthisbinding
	override hasThisBinding(): boolean {
		return false;
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-declarative-environment-records-hassuperbinding
	override hasSuperBinding(): boolean {
		return false;
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-declarative-environment-records-withbaseobject
	override withBaseObject(): EngineValue {
		return EngineValue.undefined();
	}
}

// https://tc39.es/ecma262/#sec-object-environment-records
export class ObjectEnvironmentRecord extends EnvironmentRecord {
	bindingObject: EngineValue<"object">;
	private isWithEnvironment: boolean = false;

	constructor(bindingObject: EngineValue<"object">, isWithEnvironment: boolean) {
		super();

		this.bindingObject = bindingObject;
		this.isWithEnvironment = isWithEnvironment;
	}

	// https://tc39.es/ecma262/#sec-object-environment-records-hasbinding-n
	override hasBinding(name: string): boolean {
		const foundBinding = unwrapCompletion(hasProperty(this.bindingObject, name));
		if (!foundBinding.data.value) {
			return false;
		}

		if (!this.isWithEnvironment) {
			return true;
		}

		const unscopables = unwrapCompletion(
			get(this.bindingObject, WELL_KNOWN_SYMBOLS["%Symbol.unscopables%"]),
		);

		if (unscopables.isObject()) {
			const blocked = toBoolean(unwrapCompletion(get(unscopables, name)));
			if (blocked.data.value) {
				return false;
			}
		}

		return true;
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-object-environment-records-createmutablebinding-n-d
	override createMutableBinding(name: string, deletable?: boolean) {
		unwrapCompletion(
			definePropertyOrThrow(
				this.bindingObject,
				name,
				new PropertyDescriptor({
					value: EngineValue.undefined(),
					writable: true,
					enumerable: true,
					configurable: deletable ?? false,
				}),
			),
		);
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-object-environment-records-createimmutablebinding-n-s
	override createImmutableBinding(_name: string, _strict: boolean) {
		throw new Error("Spec doesn't provide an implementation for this method.");
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-object-environment-records-initializebinding-n-v
	override initializeBinding(name: string, value: EngineValue) {
		this.setMutableBinding(name, value, false);
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-object-environment-records-setmutablebinding-n-v-s
	override setMutableBinding(name: string, value: EngineValue, strict?: boolean) {
		const stillExists = unwrapCompletion(hasProperty(this.bindingObject, name));
		if (!stillExists.data.value && strict) {
			throw new ReferenceError(`Binding for ${name} does not exist.`);
		}

		unwrapCompletion(set(this.bindingObject, name, value, strict ?? true));
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-object-environment-records-getbindingvalue-n-s
	override getBindingValue(name: string, strict?: boolean) {
		const stillExists = unwrapCompletion(hasProperty(this.bindingObject, name));
		if (!stillExists.data.value) {
			if (!strict) {
				return EngineValue.undefined();
			}

			throw new ReferenceError(`Binding for ${name} does not exist.`);
		}

		return unwrapCompletion(get(this.bindingObject, name));
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-object-environment-records-deletebinding-n
	override deleteBinding(name: string) {
		return unwrapCompletion(
			this.bindingObject.objectGetInternalSlot("Delete")(this.bindingObject, name),
		).data.value;
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-object-environment-records-hasthisbinding
	override hasThisBinding(): boolean {
		return false;
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-object-environment-records-hassuperbinding
	override hasSuperBinding(): boolean {
		return false;
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-object-environment-records-hassuperbinding
	override withBaseObject(): EngineValue {
		if (this.isWithEnvironment) {
			return this.bindingObject;
		}

		return EngineValue.undefined();
	}
}

// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-function-environment-records
export class FunctionEnvironmentRecord extends DeclarativeEnvironmentRecord {
	private thisValue: EngineValue | undefined;
	private thisBindingStatus: "lexical" | "initialized" | "uninitialized" =
		"uninitialized";

	private functionObject: EngineValue<"object"> | undefined;
	private newTarget: EngineValue | undefined;

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-bindthisvalue
	bindThisValue(thisValue: EngineValue): void {
		if (this.thisBindingStatus === "initialized") {
			throw new TypeError(
				"Cannot change 'this' binding in initialized function environment record",
			);
		}

		this.thisValue = thisValue;
		this.thisBindingStatus = "initialized";
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-function-environment-records-hasthisbinding
	override hasThisBinding(): boolean {
		return this.thisBindingStatus !== "lexical";
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-function-environment-records-hasthisbinding
	override hasSuperBinding(): boolean {
		if (this.thisBindingStatus === "lexical") {
			return false;
		}

		const fO = this.functionObject!;

		return !fO.objectGetInternalSlot("HomeObject").isUndefined();
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-function-environment-records-getthisbinding
	getThisBinding() {
		if (this.thisBindingStatus === "uninitialized") {
			throw new ReferenceError("this is not defined");
		}

		return this.thisValue!;
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-getsuperbase
	getSuperBase() {
		const fO = this.functionObject!;
		const homeObject = fO.objectGetInternalSlot("HomeObject");
		if (homeObject.isUndefined()) {
			return homeObject;
		}

		return homeObject.asObject().objectGetInternalSlot("GetPrototypeOf")(
			homeObject.asObject(),
		).value!;
	}
}

// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-global-environment-records
export class GlobalEnvironmentRecord extends EnvironmentRecord {
	private objectRecord: ObjectEnvironmentRecord;
	private globalThisValue: EngineValue<"object">;
	private declarativeRecord: DeclarativeEnvironmentRecord;

	constructor(
		objectRecord: ObjectEnvironmentRecord,
		globalThisValue: EngineValue<"object">,
		declarativeRecord: DeclarativeEnvironmentRecord,
	) {
		super();

		this.objectRecord = objectRecord;
		this.globalThisValue = globalThisValue;
		this.declarativeRecord = declarativeRecord;
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-global-environment-records-hasbinding-n
	override hasBinding(name: string): boolean {
		return this.declarativeRecord.hasBinding(name) || this.objectRecord.hasBinding(name);
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-global-environment-records-createmutablebinding-n-d
	override createMutableBinding(name: string, deletable?: boolean) {
		if (this.declarativeRecord.hasBinding(name)) {
			throw new TypeError(`Binding ${name} already exists in declarative record.`);
		}

		this.declarativeRecord.createMutableBinding(name, deletable);
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-global-environment-records-createimmutablebinding-n-s
	override createImmutableBinding(name: string, strict: boolean) {
		if (this.declarativeRecord.hasBinding(name)) {
			throw new TypeError(`Binding ${name} already exists in declarative record.`);
		}

		this.declarativeRecord.createImmutableBinding(name, strict);
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-global-environment-records-initializebinding-n-v
	override initializeBinding(name: string, value: EngineValue) {
		if (this.declarativeRecord.hasBinding(name)) {
			return this.declarativeRecord.initializeBinding(name, value);
		}
		return this.objectRecord.initializeBinding(name, value);
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-global-environment-records-setmutablebinding-n-v-s
	override setMutableBinding(name: string, value: EngineValue, strict?: boolean) {
		if (this.declarativeRecord.hasBinding(name)) {
			return this.declarativeRecord.setMutableBinding(name, value, strict);
		}
		return this.objectRecord.setMutableBinding(name, value, strict);
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-global-environment-records-getbindingvalue-n-s
	override getBindingValue(name: string, strict?: boolean) {
		if (this.declarativeRecord.hasBinding(name)) {
			return this.declarativeRecord.getBindingValue(name, strict);
		}
		return this.objectRecord.getBindingValue(name, strict);
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-global-environment-records-deletebinding-n
	override deleteBinding(name: string) {
		if (this.declarativeRecord.hasBinding(name)) {
			return this.declarativeRecord.deleteBinding(name);
		}

		const existingProp = unwrapCompletion(
			hasOwnProperty(this.objectRecord.bindingObject, name),
		);

		if (existingProp.data.value) {
			return this.objectRecord.deleteBinding(name);
		}

		return true;
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-global-environment-records-hasthisbinding
	override hasThisBinding(): boolean {
		return true;
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-global-environment-records-hassuperbinding
	override hasSuperBinding(): boolean {
		return false;
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-global-environment-records-withbaseobject
	override withBaseObject(): EngineValue {
		return EngineValue.undefined();
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-global-environment-records-getthisbinding
	getThisBinding() {
		return this.globalThisValue;
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-haslexicaldeclaration
	hasLexicalDeclaration(name: string): boolean {
		return this.declarativeRecord.hasBinding(name);
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-hasrestrictedglobalproperty
	hasRestrictedGlobalProperty(name: string): boolean {
		const existingProp = unwrapCompletion(
			this.objectRecord.bindingObject.objectGetInternalSlot("GetOwnProperty")(
				this.objectRecord.bindingObject,
				name,
			),
		);

		if (existingProp instanceof EngineValue) {
			return false;
		}

		if (existingProp.configurable) {
			return false;
		}

		return true;
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-candeclareglobalvar
	canDeclareGlobalVar(name: string): boolean {
		const hasProperty = unwrapCompletion(
			hasOwnProperty(this.objectRecord.bindingObject, name),
		);
		if (hasProperty.data.value) {
			return false;
		}

		return unwrapCompletion(isExtensible(this.objectRecord.bindingObject)).data.value;
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-candeclareglobalfunction
	canDeclareGlobalFunction(name: string): boolean {
		const existingProp = unwrapCompletion(
			this.objectRecord.bindingObject.objectGetInternalSlot("GetOwnProperty")(
				this.objectRecord.bindingObject,
				name,
			),
		);

		if (existingProp instanceof EngineValue) {
			return unwrapCompletion(isExtensible(this.objectRecord.bindingObject)).data.value;
		}

		if (existingProp.configurable) {
			return true;
		}

		if (
			existingProp.isDataDescriptor() &&
			existingProp.writable &&
			existingProp.enumerable
		) {
			return true;
		}

		return false;
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-createglobalvarbinding
	createGlobalVarBinding(name: string, deletable?: boolean): void {
		const hasProp = unwrapCompletion(
			hasOwnProperty(this.objectRecord.bindingObject, name),
		).data.value;
		const extensible = unwrapCompletion(isExtensible(this.objectRecord.bindingObject))
			.data.value;

		if (!hasProp && extensible) {
			this.objectRecord.createMutableBinding(name, deletable);
			this.objectRecord.initializeBinding(name, EngineValue.undefined());
		}
	}

	// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-createglobalfunctionbinding
	createGlobalFunctionBinding(
		name: string,
		value: EngineValue,
		deletable?: boolean,
	): void {
		const existingProp = unwrapCompletion(
			this.objectRecord.bindingObject.objectGetInternalSlot("GetOwnProperty")(
				this.objectRecord.bindingObject,
				name,
			),
		);

		const desc =
			existingProp instanceof EngineValue || existingProp.configurable ?
				new PropertyDescriptor({
					value,
					writable: true,
					enumerable: true,
					configurable: deletable ?? false,
				})
			:	new PropertyDescriptor({
					value,
				});

		definePropertyOrThrow(this.objectRecord.bindingObject, name, desc);
		set(this.objectRecord.bindingObject, name, value, false);
	}
}

// https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-module-environment-records
export class ModuleEnvironmentRecord extends DeclarativeEnvironmentRecord {
	// TODO!: Needs module records! Module stuff can be 'indirect' bindings for imports.
}
