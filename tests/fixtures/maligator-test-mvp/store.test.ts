import { beforeEach, describe, expect, test } from "maligator:test";
import { createStore, DuplicateKeyError } from "./store.ts";

describe("store", () => {
	let store: ReturnType<typeof createStore>;

	beforeEach(() => {
		store = createStore();
	});

	test("returns inserted values", () => {
		store.set("answer", 42);
		expect(store.get("answer")).toBe(42);
	});

	test("supports asynchronous loaders", async () => {
		store.set("answer", 42);
		await expect(store.load("answer")).resolves.toEqual(42);
	});

	test("rejects duplicate keys", async () => {
		await expect(store.insert("answer", 42)).resolves.toBeDefined();
		await expect(store.insert("answer", 43)).rejects.toThrow(DuplicateKeyError);
	});

	test("supports structural and asymmetric values", () => {
		expect({ name: "store", values: [40, 41, 42] }).toMatchObject({
			name: expect.stringMatching(/^sto/),
			values: expect.arrayContaining([expect.any(Number), 42]),
		});
	});
});
