import { readFileSync } from "node:fs";
import * as path from "node:path";
import { createBuiltinFunction } from "../engine/abstract-operations/built-in-function-object.ts";
import { definePropertyOrThrow } from "../engine/abstract-operations/object-operations.ts";
import { ordinaryObjectCreate } from "../engine/abstract-operations/ordinary-object.ts";
import { PropertyDescriptor } from "../engine/abstract-operations/property-map.ts";
import {
	getCurrentRealm,
	popExecutionContextTillEmpty,
} from "../engine/execution-contexts/execution-context.ts";
import { Realm } from "../engine/execution-contexts/realm.ts";
import { parseScript } from "../engine/parser/script.ts";
import { evaluate, EvaluateError } from "../engine/runtime-semantics/index.ts";
import { normalCompletion } from "../engine/types-and-values/completion-record.ts";
import { EngineValue } from "../engine/types-and-values/data-types.ts";
import { TEST262_METADATA } from "./constants.ts";
import type { Test262File } from "./types.ts";

const SKIPPED_FLAGS = ["module", "async", "CanBlockIsTrue"];
const SKIPPED_FEATURES = [
	"IsHTMLDDA",
	"decorators",
	"explicit-resource-management",
	"Temporal",
];
const SKIPPED_PATHS = ["annexB", "intl402"];

const HARNESS_CACHE: Record<string, string> = {};

const FAILURE_CACHE: Record<string, Array<string>> = {};

export function test262RunFile(file: Test262File) {
	if (shouldSkipFile(file)) {
		file.result = "SKIPPED";
		return;
	}

	const fileToLoad =
		file.frontmatter.flags?.includes("raw") ?
			[]
		:	["harness/assert.js", "harness/sta.js"];
	fileToLoad.push(...(file.frontmatter.includes ?? []).map((it) => `harness/${it}`));

	if (!file.frontmatter.flags?.includes("onlyStrict")) {
		try {
			Realm.init();
			const realm = getCurrentRealm();

			// TODO: watch 'printResults'
			test262PrepareExecutionRealm(realm);

			for (const path of fileToLoad) {
				const contents = loadHarnessFile(path);
				const parsed = parseScript(contents, realm);
				const result = evaluate(parsed.ECMAScriptCode);

				if (result.type !== "normal") {
					normalizeAndCountFailureReason(file, result);
					file.result = "FAILED";
					break;
				}
			}

			if (file.result !== "FAILED") {
				const parsed = parseScript(`${file.content}`, getCurrentRealm());
				const result = evaluate(parsed.ECMAScriptCode);
				if (result.type !== "normal") {
					normalizeAndCountFailureReason(file, result);
					file.result = "FAILED";
				} else {
					file.result = "PASSED";
				}
			}
		} catch (e) {
			normalizeAndCountFailureReason(file, e);
			file.result = "FAILED";
		} finally {
			popExecutionContextTillEmpty();
		}
	}

	if (
		file.result !== "FAILED" &&
		file.result !== "STRICT_FAILED" &&
		!file.frontmatter.flags?.includes("noStrict") &&
		!file.frontmatter.flags?.includes("raw")
	) {
		try {
			Realm.init();
			const realm = getCurrentRealm();

			// TODO: watch 'printResults'
			test262PrepareExecutionRealm(realm);

			for (const path of fileToLoad) {
				const contents = loadHarnessFile(path);
				const parsed = parseScript(contents, realm);
				const result = evaluate(parsed.ECMAScriptCode);

				if (result.type !== "normal") {
					normalizeAndCountFailureReason(file, result);
					file.result = "FAILED";
					break;
				}
			}

			if (file.result !== "FAILED") {
				const parsed = parseScript(`"use strict";\n${file.content}`, getCurrentRealm());
				const result = evaluate(parsed.ECMAScriptCode);

				if (result.type !== "normal") {
					normalizeAndCountFailureReason(file, result);
					file.result = "STRICT_FAILED";
				} else {
					file.result = "PASSED";
				}
			}
		} catch (e) {
			normalizeAndCountFailureReason(file, e);
			file.result = "STRICT_FAILED";
		} finally {
			popExecutionContextTillEmpty();
		}
	}
}

export function test262PrepareExecutionRealm(realm: Realm) {
	const printResults: Array<string> = [];

	// TODO: Define properties on `Realm#hostDefined`?

	definePropertyOrThrow(
		realm.globalObject!,
		"print",
		new PropertyDescriptor({
			value: createBuiltinFunction(
				(_this, args, _newTarget) => {
					const zeroArg = args[0];
					if (zeroArg?.isString()) {
						printResults.push(zeroArg.data.value);
					}

					return normalCompletion(EngineValue.undefined());
				},
				1,
				"print",
				[],
				realm,
			),
			writable: true,
			configurable: true,
			enumerable: false,
		}),
	);

	const $262 = ordinaryObjectCreate(EngineValue.null());

	// TODO: Other $262 props.

	definePropertyOrThrow(
		$262,
		"global",
		new PropertyDescriptor({
			value: realm.globalObject!,
			writable: true,
			configurable: true,
			enumerable: false,
		}),
	);

	definePropertyOrThrow(
		realm.globalObject!,
		"$262",
		new PropertyDescriptor({
			value: $262,
			writable: true,
			configurable: true,
			enumerable: false,
		}),
	);

	return {
		printResults,
	};
}

function loadHarnessFile(file: string) {
	if (HARNESS_CACHE[file]) {
		return HARNESS_CACHE[file];
	}

	const contents = readFileSync(path.join(TEST262_METADATA.path, file), "utf-8");
	HARNESS_CACHE[file] = contents;

	return contents;
}

function shouldSkipFile(file: Test262File) {
	if (file.frontmatter.negative) {
		return true;
	}

	for (const flag of SKIPPED_FLAGS) {
		if (file.frontmatter.flags?.includes(flag)) {
			return true;
		}
	}

	for (const feature of SKIPPED_FEATURES) {
		if (file.frontmatter.features?.includes(feature)) {
			return true;
		}
	}

	for (const part of SKIPPED_PATHS) {
		if (file.path.includes(part)) {
			return true;
		}
	}

	return false;
}

function normalizeAndCountFailureReason(file: Test262File, reason: unknown) {
	if (reason instanceof EvaluateError) {
		FAILURE_CACHE[reason.error.message] ??= [];
		FAILURE_CACHE[reason.error.message]!.push(file.path);
		return;
	}

	if (
		!!reason &&
		typeof reason === "object" &&
		"message" in reason &&
		typeof reason.message === "string"
	) {
		FAILURE_CACHE[reason.message] ??= [];
		FAILURE_CACHE[reason.message]!.push(file.path);
		return;
	}

	if (!!reason && typeof reason === "object" && "error" in reason) {
		normalizeAndCountFailureReason(file, reason.error);
		return;
	}

	if (!!reason && typeof reason === "object" && "value" in reason) {
		if (
			reason.value instanceof EngineValue &&
			reason.value.isObject() &&
			reason.value.data.properties.has("message") &&
			reason.value.data.properties.get("message").value?.isString()
		) {
			const msg = reason.value.data.properties.get("message").value!.asString()
				.data.value;
			FAILURE_CACHE[msg] ??= [];
			FAILURE_CACHE[msg].push(file.path);
			return;
		}
	}

	// test262Log("Unknown failure: ", reason);

	FAILURE_CACHE["unknown"] ??= [];
	FAILURE_CACHE["unknown"].push(file.path);
}

export function getFailuresWithSamples() {
	const sortedFailures = Object.entries(FAILURE_CACHE).sort(
		(a, b) => b[1].length - a[1].length,
	);

	const uniqueFailureReasons = sortedFailures.length;
	return {
		uniqueFailureReasons,
		failures: sortedFailures.slice(0, 10).map(([reason, paths]) => ({
			reason,
			paths: Array.from({ length: 10 }).map(
				() => paths[Math.floor(Math.random() * paths.length)],
			),
		})),
	};
}
