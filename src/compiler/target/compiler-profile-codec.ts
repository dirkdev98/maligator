import type { ProfileSite } from "./profile-metadata.ts";
import type { Reader, Writer } from "./program-image-codec.ts";
import type { ProgramImage } from "./program-image.ts";
import type { BytecodeFunction } from "./runtime-image.ts";

type CompilerSites = ReadonlyArray<string | undefined>;
type ProfileFunction = {
	readonly body: BytecodeFunction;
	readonly compilerSiteIds?: CompilerSites;
};

function integer(value: number, minimum = 0, count = 0x80000000): boolean {
	return Number.isInteger(value) && value >= minimum && value < count;
}

function validateInstructionSites(
	fn: BytecodeFunction,
	sites: ReadonlyArray<ProfileSite> | undefined,
): void {
	const ids = fn.profileSiteIds;
	if (
		ids !== undefined &&
		(sites === undefined ||
			ids.length !== fn.instructions.length ||
			ids.some((id) => !integer(id, -1, sites.length)))
	)
		throw new RangeError("compiler-profile-codec: invalid instruction profile sites");
}

function validateProfiling(
	profiling: ProgramImage["profiling"],
	runtime: ReadonlyArray<BytecodeFunction>,
	native: ReadonlyArray<ProfileFunction>,
): void {
	const sites = profiling?.sites;
	for (const [index, site] of (sites ?? []).entries()) {
		if (
			site === undefined ||
			site.id !== index ||
			!integer(site.functionIndex, 0, runtime.length) ||
			!integer(
				site.instructionIndex,
				0,
				Math.max(
					runtime[site.functionIndex]!.instructions.length,
					native[site.functionIndex]!.body.instructions.length,
				),
			) ||
			!integer(site.positionId) ||
			!integer(site.line, 1) ||
			!integer(site.column) ||
			![
				site.logicalId,
				site.originId,
				site.instanceId,
				site.regionId,
				site.file,
				site.operation,
			].every((text) => typeof text === "string") ||
			site.inlineChain.some(
				(entry) =>
					!integer(entry.functionIndex, 0, runtime.length) || !integer(entry.positionId),
			)
		)
			throw new RangeError("compiler-profile-codec: invalid profile site");
	}
	for (const fn of runtime) validateInstructionSites(fn, sites);
	for (const fn of native) {
		validateInstructionSites(fn.body, sites);
		const ids = fn.compilerSiteIds;
		if (
			ids !== undefined &&
			(ids.length !== fn.body.instructions.length ||
				ids.some((id) => id !== undefined && typeof id !== "string"))
		)
			throw new RangeError("compiler-profile-codec: invalid compiler sites");
	}
}

function writeString(w: Writer, text: string): void {
	w.u32(text.length);
	for (let index = 0; index < text.length; index++) w.u16(text.charCodeAt(index));
}

function readString(r: Reader): string {
	const length = r.count(2);
	let text = "";
	for (let index = 0; index < length; index++) text += String.fromCharCode(r.u16());
	return text;
}

function writeInstructionSites(w: Writer, fn: BytecodeFunction): void {
	w.u8(fn.profileSiteIds === undefined ? 0 : 1);
	if (fn.profileSiteIds !== undefined) w.i32Array(fn.profileSiteIds);
}

function readInstructionSites(r: Reader, fn: BytecodeFunction): void {
	const present = r.u8();
	if (present > 1)
		throw new RangeError("compiler-profile-codec: invalid profile table tag");
	if (present !== 0) fn.profileSiteIds = r.i32Array();
}

export function writeCompilerProfiling(w: Writer, image: ProgramImage): void {
	validateProfiling(image.profiling, image.runtime.functions, image.native.functions);
	const sites = image.profiling?.sites;
	const compilerSites = image.native.functions.some(
		(fn) => fn.compilerSiteIds !== undefined,
	);
	w.u8((sites === undefined ? 0 : 1) | (compilerSites ? 2 : 0));
	if (sites !== undefined) {
		w.u32(sites.length);
		for (const site of sites) {
			for (const text of [
				site.logicalId,
				site.originId,
				site.instanceId,
				site.regionId,
				site.file,
				site.operation,
			])
				writeString(w, text);
			w.i32(site.functionIndex);
			w.i32(site.instructionIndex);
			w.i32(site.positionId);
			w.i32(site.line);
			w.i32(site.column);
			w.u32(site.inlineChain.length);
			for (const entry of site.inlineChain) {
				w.i32(entry.functionIndex);
				w.i32(entry.positionId);
			}
		}
		for (const fn of image.runtime.functions) writeInstructionSites(w, fn);
		for (const fn of image.native.functions) writeInstructionSites(w, fn.body);
	}
	if (compilerSites)
		for (const fn of image.native.functions) {
			w.u8(fn.compilerSiteIds === undefined ? 0 : 1);
			if (fn.compilerSiteIds !== undefined) {
				w.u32(fn.compilerSiteIds.length);
				for (const id of fn.compilerSiteIds) {
					w.u8(id === undefined ? 0 : 1);
					if (id !== undefined) writeString(w, id);
				}
			}
		}
}

export function readCompilerProfiling(
	r: Reader,
	runtime: ReadonlyArray<BytecodeFunction>,
	bodies: ReadonlyArray<BytecodeFunction>,
): {
	profiling?: NonNullable<ProgramImage["profiling"]>;
	compilerSiteIds?: ReadonlyArray<CompilerSites | undefined>;
} {
	const flags = r.u8();
	if (flags > 3) throw new RangeError("compiler-profile-codec: invalid profiling flags");
	if (flags === 0) return {};
	let profiling: ProgramImage["profiling"];
	if ((flags & 1) !== 0) {
		const count = r.count(12);
		const sites: Array<ProfileSite> = [];
		for (let id = 0; id < count; id++) {
			const logicalId = readString(r),
				originId = readString(r),
				instanceId = readString(r),
				regionId = readString(r),
				file = readString(r),
				operation = readString(r);
			const functionIndex = r.i32(),
				instructionIndex = r.i32(),
				positionId = r.i32(),
				line = r.i32(),
				column = r.i32();
			const chainCount = r.count(2);
			const inlineChain = Array.from({ length: chainCount }, () => ({
				functionIndex: r.i32(),
				positionId: r.i32(),
			}));
			sites.push({
				id,
				logicalId,
				originId,
				instanceId,
				regionId,
				file,
				operation,
				functionIndex,
				instructionIndex,
				positionId,
				line,
				column,
				inlineChain,
			});
		}
		profiling = { sites };
		for (const fn of runtime) readInstructionSites(r, fn);
		for (const fn of bodies) readInstructionSites(r, fn);
	}
	let compilerSiteIds: Array<CompilerSites | undefined> | undefined;
	if ((flags & 2) !== 0) {
		compilerSiteIds = bodies.map((fn) => {
			const present = r.u8();
			if (present > 1)
				throw new RangeError("compiler-profile-codec: invalid compiler table tag");
			if (present === 0) return undefined;
			const count = r.count(1);
			if (count !== fn.instructions.length)
				throw new RangeError("compiler-profile-codec: invalid compiler site count");
			return Array.from({ length: count }, () => {
				const present = r.u8();
				if (present > 1)
					throw new RangeError("compiler-profile-codec: invalid compiler site tag");
				return present === 0 ? undefined : readString(r);
			});
		});
	}
	validateProfiling(
		profiling,
		runtime,
		bodies.map((body, index) => ({ body, compilerSiteIds: compilerSiteIds?.[index] })),
	);
	return {
		...(profiling === undefined ? {} : { profiling }),
		...(compilerSiteIds === undefined ? {} : { compilerSiteIds }),
	};
}
