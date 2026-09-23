import { hash } from "node:crypto";
import type {
	SourceCallSite,
	SourceFunctionOrigin,
} from "./compiler/frontend/source-function-origins.ts";

export type ProfileFunctionIdentity =
	| {
			readonly status: "known" | "shared";
			readonly origin: string;
			readonly revision: string;
			readonly portability: "portable" | "checkout";
	  }
	| { readonly status: "unknown" | "ambiguous"; readonly reason: string };

export type ProfileCallIdentity =
	| {
			readonly status: "known";
			readonly key: string;
			readonly owner: string;
			readonly revision: string;
	  }
	| { readonly status: "unknown" | "ambiguous"; readonly reason: string };

export class SourceProfileIdentities {
	readonly #functions = new Map<SourceFunctionOrigin, ProfileFunctionIdentity>();
	readonly #classRevisions = new Map<string, string>();

	functionIdentity(source: SourceFunctionOrigin | undefined): ProfileFunctionIdentity {
		if (source === undefined) return { status: "unknown", reason: "no-source-origin" };
		const cached = this.#functions.get(source);
		if (cached !== undefined) return cached;
		if (source.status !== "captured")
			return { status: source.status, reason: source.reason };
		const declaration = {
			version: 1,
			module: source.source.moduleKey,
			portability: source.source.portability,
			declaration: source.declaration,
		};
		let classRevision: string | undefined;
		if (source.classSource !== undefined) {
			classRevision = this.#classRevisions.get(source.classSource);
			if (classRevision === undefined) {
				classRevision = hash("sha256", source.classSource, "hex");
				this.#classRevisions.set(source.classSource, classRevision);
			}
		}
		const identity: ProfileFunctionIdentity = {
			status: "known",
			origin: hash("sha256", canonicalProfileJson(declaration), "hex"),
			revision: hash(
				"sha256",
				canonicalProfileJson({
					...declaration,
					goal: source.source.goal,
					commonjs: source.source.commonjs,
					strict: source.strict,
					kind: source.kind,
					async: source.async,
					generator: source.generator,
					bindings: source.bindings,
					classRevision,
					source: source.source.contents.slice(source.start, source.end),
				}),
				"hex",
			),
			portability: source.portability,
		};
		this.#functions.set(source, identity);
		return identity;
	}

	callIdentity(site: SourceCallSite): ProfileCallIdentity {
		const owner = this.functionIdentity(site.owner);
		if ("reason" in owner) return owner;
		if (site.start === undefined || site.end === undefined)
			return { status: "unknown", reason: "missing-source-span" };
		return {
			status: "known",
			owner: owner.origin,
			revision: owner.revision,
			key: hash(
				"sha256",
				JSON.stringify([
					1,
					owner.origin,
					owner.revision,
					site.start,
					site.end,
					site.kind,
				]),
				"hex",
			),
		};
	}
}

export function canonicalProfileJson(value: unknown): string {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) throw new Error("profile metadata is not serializable");
		return encoded;
	}
	if (Array.isArray(value)) return `[${value.map(canonicalProfileJson).join(",")}]`;
	if (typeof value !== "object") throw new Error("profile metadata is not serializable");
	return `{${Object.entries(value)
		.filter(([, entry]) => entry !== undefined)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalProfileJson(entry)}`)
		.join(",")}}`;
}
