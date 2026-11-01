import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomically } from "../atomic-file.ts";
import type { MaligatorFfiEvidence } from "../public-api.d.ts";
import type { JsValue } from "./binding-plan.ts";
import type { CFunction } from "./c-model.ts";
import type { CType } from "./c-type.ts";
import { FfiError } from "./ffi-error.ts";
import type { PreparedLibrary } from "./library.ts";
import type { FfiProbeReport } from "./probe.ts";

type Json =
	| null
	| boolean
	| number
	| string
	| ReadonlyArray<Json>
	| { readonly [key: string]: Json };
type Snapshot = Readonly<Record<string, Json>>;

interface Lockfile {
	readonly schema: 1;
	readonly targets: Readonly<Record<string, Readonly<Record<string, Snapshot>>>>;
}

export interface FfiChange {
	readonly path: string;
	readonly kind: "added" | "removed" | "changed";
	readonly before?: Json;
	readonly after?: Json;
}

export interface FfiCheckReport {
	readonly file: string;
	readonly target: string;
	readonly ok: boolean;
	readonly libraries: ReadonlyArray<FfiLibraryCheck>;
	readonly probe?: FfiProbeReport;
}

export interface FfiLibraryCheck {
	readonly library: string;
	readonly status: "current" | "missing" | "changed" | "removed" | "updated";
	readonly changes: ReadonlyArray<FfiChange>;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(value: unknown): Json {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "bigint") return value.toString();
	if (Array.isArray(value)) return value.map(json);
	if (isObject(value)) {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.flatMap((key) => (value[key] === undefined ? [] : [[key, json(value[key])]])),
		);
	}
	throw new FfiError("cannot record an unsupported value in the FFI lockfile");
}

function documentationEvidence(prepared: PreparedLibrary): Snapshot {
	const { model, contract } = prepared;
	const result: Record<string, Json> = {};
	const children = (
		entries: ReadonlyArray<{ readonly name?: string; readonly doc?: string }>,
	): Snapshot =>
		Object.fromEntries(
			entries.flatMap((entry, index) =>
				entry.doc === undefined ? [] : [[entry.name ?? String(index + 1), entry.doc]],
			),
		);
	const cite = (reference: MaligatorFfiEvidence, at: string): void => {
		const key = `${reference.kind} ${reference.name}`;
		if (key in result) return;
		let doc: string | undefined;
		let members: Snapshot | undefined;
		let exists = false;
		switch (reference.kind) {
			case "function": {
				const entry = model.functions.find((value) => value.name === reference.name);
				exists = entry !== undefined;
				doc = entry?.doc;
				if (entry !== undefined) members = children(entry.params);
				break;
			}
			case "typedef": {
				const entry = model.typedefs.get(reference.name);
				exists = entry !== undefined;
				doc = entry?.doc;
				break;
			}
			case "struct":
			case "union": {
				const entry = model.records.get(reference.name);
				exists = entry?.named === true && entry.tag === reference.kind;
				doc = entry?.doc;
				if (entry !== undefined) members = children(entry.fields);
				break;
			}
			case "enum": {
				const entry = model.enums.get(reference.name);
				exists = entry?.named === true;
				doc = entry?.doc;
				if (entry !== undefined) members = children(entry.constants);
				break;
			}
			case "macro": {
				const entry = [...model.macros, ...model.untypedMacros].find(
					(value) => value.name === reference.name,
				);
				exists = entry !== undefined;
				doc = entry?.doc;
				break;
			}
		}
		if (!exists)
			throw new FfiError(`${contract.name}: ${at}: the headers declare no ${key}`);
		if (doc === undefined && Object.keys(members ?? {}).length === 0)
			throw new FfiError(
				`${contract.name}: ${at}: ${key} has no extracted documentation`,
			);
		result[key] = json({ doc, members });
	};
	for (const category of ["types", "functions"] as const)
		for (const [name, facts] of Object.entries<{
			readonly evidence?: ReadonlyArray<MaligatorFfiEvidence>;
		}>(contract.facts[category]))
			facts.evidence?.forEach((reference, index) =>
				cite(reference, `${category}.${name}.evidence[${index}]`),
			);
	return result;
}

/** Snapshot only declarations reachable from exports or accepted facts, without source locations. */
function snapshot(prepared: PreparedLibrary): Snapshot {
	const { model, plan, contract } = prepared;
	const evidence = documentationEvidence(prepared);
	const declarations: Record<string, Json> = {};
	const functions = new Map(model.functions.map((entry) => [entry.name, entry]));
	const macros = new Map(model.macros.map((entry) => [entry.name, entry]));
	const anonymous = new Map<string, string>();
	const typeName = (kind: string, name: string, at: string): string => {
		if (/^[A-Za-z_]\w*$/.test(name)) return `${kind} ${name}`;
		const key = `${kind} ${name}`;
		let stable = anonymous.get(key);
		if (stable === undefined) {
			stable = `${kind} at ${at}`;
			anonymous.set(key, stable);
		}
		return stable;
	};
	const type = (value: CType, at: string): Json => {
		switch (value.kind) {
			case "pointer":
				return json({ ...value, to: type(value.to, `${at}.*`) });
			case "array":
				return json({ ...value, of: type(value.of, `${at}[]`) });
			case "function":
				return json({
					...value,
					returns: type(value.returns, `${at}.return`),
					params: value.params.map((param, index) =>
						type(param, `${at}.param${index + 1}`),
					),
				});
			case "typedef": {
				const key = `typedef ${value.name}`;
				if (!(key in declarations)) {
					declarations[key] = null;
					const entry = model.typedefs.get(value.name);
					declarations[key] = entry === undefined ? null : type(entry.type, key);
				}
				return json(value);
			}
			case "record": {
				const key = typeName(value.tag, value.name, at);
				if (!(key in declarations)) {
					declarations[key] = null;
					const entry = model.records.get(value.name);
					declarations[key] =
						entry === undefined
							? null
							: json({
									complete: entry.complete,
									fields: entry.fields.map((field, index) => ({
										name: field.name,
										bitWidth: field.bitWidth,
										type: type(field.type, `${key}.${field.name ?? `field${index + 1}`}`),
									})),
								});
				}
				return json({ ...value, name: key });
			}
			case "enum": {
				const key = typeName("enum", value.name, at);
				if (!(key in declarations)) {
					declarations[key] = null;
					const entry = model.enums.get(value.name);
					declarations[key] =
						entry === undefined
							? null
							: json({
									underlying: type(entry.underlying, key),
									constants: Object.fromEntries(
										entry.constants.map(({ name, value }) => [name, value]),
									),
								});
				}
				return json({ ...value, name: key });
			}
			default:
				return json(value);
		}
	};
	const addFunction = (entry: CFunction, name = entry.name): void => {
		const key = `function ${name}`;
		if (key in declarations) return;
		declarations[key] = null;
		declarations[key] = json({
			name: entry.name,
			returns: type(entry.returns, `${key}.return`),
			params: entry.params.map((param, index) => ({
				name: param.name,
				type: type(param.type, `${key}.param${index + 1}`),
			})),
			variadic: entry.variadic,
			inline: entry.inline,
			attributes: [...entry.attributes].sort(),
		});
	};
	const helper = (name: string): void => {
		const entry = functions.get(name);
		if (entry !== undefined) addFunction(entry);
	};
	const mapping = (value: JsValue): void => {
		if ("free" in value && value.free !== undefined) helper(value.free);
		if (value.kind === "callback") {
			if (value.lookup !== undefined) helper(value.lookup.function);
			for (const param of value.params) if (typeof param !== "string") mapping(param);
			mapping(value.returns);
		} else if (value.kind === "array" || value.kind === "sequence") mapping(value.of);
	};
	for (const name of Object.keys(contract.facts.functions).sort()) helper(name);
	for (const name of Object.keys(contract.facts.types).sort()) {
		if (model.typedefs.has(name)) type({ kind: "typedef", name }, `type fact ${name}`);
		else {
			const record = model.records.get(name);
			if (record !== undefined)
				type({ kind: "record", tag: record.tag, name }, `type fact ${name}`);
			else if (model.enums.has(name)) type({ kind: "enum", name }, `type fact ${name}`);
		}
	}
	for (const binding of [...plan.functions].sort((a, b) =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
	)) {
		addFunction(binding.declaration, binding.name);
		helper(binding.declaration.name);
		for (const param of binding.params) mapping(param.value);
		for (const output of binding.outputs) mapping(output.value);
		mapping(binding.returns);
	}
	for (const handle of [...plan.handles.values()].sort((a, b) =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
	)) {
		const record = model.records.get(handle.name);
		if (record !== undefined)
			type(
				{ kind: "record", tag: record.tag, name: record.name },
				`handle ${handle.name}`,
			);
		if (handle.destroy !== undefined) helper(handle.destroy.name);
	}
	for (const constant of plan.constants) {
		const macro = macros.get(constant.name);
		declarations[`constant ${constant.name}`] = json({
			type: type(constant.type, `constant ${constant.name}`),
			value: constant.known,
			body: macro?.body,
		});
	}
	return {
		headers: json(contract.headers),
		target: json(model.target),
		facts: json(contract.facts),
		declarations: json(declarations),
		...(Object.keys(evidence).length === 0 ? {} : { evidence: json(evidence) }),
	};
}

function readLockfile(file: string): Lockfile {
	if (!existsSync(file)) return { schema: 1, targets: {} };
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		throw new FfiError(`cannot read FFI lockfile ${file}: expected JSON`);
	}
	if (
		!isObject(value) ||
		value.schema !== 1 ||
		!isObject(value.targets) ||
		!Object.values(value.targets).every(
			(target) =>
				isObject(target) &&
				Object.values(target).every(
					(entry) =>
						isObject(entry) &&
						Array.isArray(entry.headers) &&
						isObject(entry.target) &&
						isObject(entry.facts) &&
						isObject(entry.declarations),
				),
		)
	) {
		throw new FfiError(
			`invalid FFI lockfile ${file}: expected schema 1 with declaration snapshots`,
		);
	}
	return value as unknown as Lockfile;
}

function changes(
	before: Json | undefined,
	after: Json | undefined,
	at: string,
	result: Array<FfiChange>,
): void {
	if (JSON.stringify(before) === JSON.stringify(after)) return;
	if (isObject(before) && isObject(after)) {
		for (const key of [
			...new Set([...Object.keys(before), ...Object.keys(after)]),
		].sort())
			changes(before[key], after[key], at === "" ? key : `${at}.${key}`, result);
		return;
	}
	result.push({
		path: at,
		kind: before === undefined ? "added" : after === undefined ? "removed" : "changed",
		...(before === undefined ? {} : { before }),
		...(after === undefined ? {} : { after }),
	});
}

/** Compare the selected target and libraries; only an explicit update accepts drift. */
export function checkLibraries(
	libraries: ReadonlyArray<PreparedLibrary>,
	options: {
		readonly file: string;
		readonly target: string;
		readonly update: boolean;
		readonly all: boolean;
	},
): FfiCheckReport {
	const lock = readLockfile(options.file);
	const previous = lock.targets[options.target] ?? {};
	const current = Object.fromEntries(
		libraries.map((library) => [library.contract.name, snapshot(library)]),
	);
	const names = [
		...new Set([...Object.keys(current), ...(options.all ? Object.keys(previous) : [])]),
	].sort();
	const reports: Array<FfiLibraryCheck> = names.map((library) => {
		const before = previous[library];
		const after = current[library];
		const differences: Array<FfiChange> = [];
		if (before !== undefined && after !== undefined)
			changes(json(before), json(after), "", differences);
		let status: FfiLibraryCheck["status"];
		if (after === undefined) status = "removed";
		else if (options.update) status = "updated";
		else if (before === undefined) status = "missing";
		else status = differences.length === 0 ? "current" : "changed";
		return {
			library,
			status,
			changes: differences,
		};
	});
	if (options.update) {
		writeFileAtomically(
			options.file,
			`${JSON.stringify(
				json({
					schema: 1,
					targets: {
						...lock.targets,
						[options.target]: options.all ? current : { ...previous, ...current },
					},
				}),
				null,
				"\t",
			)}\n`,
		);
	}
	return {
		file: options.file,
		target: options.target,
		ok: options.update || reports.every((entry) => entry.status === "current"),
		libraries: reports,
	};
}

export function formatFfiCheck(report: FfiCheckReport): string {
	return [
		`FFI declarations for ${report.target}: ${report.file}`,
		...report.libraries.flatMap((entry) => [
			`${entry.library}: ${entry.status === "missing" ? "no accepted snapshot" : entry.status}`,
			...entry.changes.map(
				(change) =>
					`  ${change.path}: ${JSON.stringify(change.before) ?? "(absent)"} -> ${JSON.stringify(change.after) ?? "(absent)"}`,
			),
		]),
		...(report.probe === undefined
			? []
			: [
					`Probe ${report.probe.path}: ${report.probe.ok ? "passed" : "failed"} (${report.probe.sanitizer === "asan" ? "ASan+UBSan" : "UBSan"})`,
					...(report.probe.error === undefined ? [] : [`  ${report.probe.error}`]),
					`Probe report: ${report.probe.report}`,
				]),
		...(report.ok
			? []
			: report.probe?.ok === false
				? ["Fix the probe failure before accepting this snapshot."]
				: [
						"Review the declarations and facts, then run maligator ffi check --update to accept them.",
					]),
	].join("\n");
}
