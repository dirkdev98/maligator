export class DuplicateKeyError extends Error {}

export function createStore() {
	const values = new Map<string, number>();
	return {
		set: (name: string, value: number): void => {
			values.set(name, value);
		},
		get: (name: string): number | undefined => {
			return values.get(name);
		},
		load: async (name: string): Promise<number | undefined> => {
			await Promise.resolve();
			return values.get(name);
		},
		insert: async (name: string, value: number): Promise<number> => {
			await Promise.resolve();
			if (values.has(name)) throw new DuplicateKeyError(`duplicate key: ${name}`);
			values.set(name, value);
			return value;
		},
	};
}
