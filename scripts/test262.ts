import { test262LoadCache, test262PersistCache } from "../src/test262/cache.ts";
import { test262Checkout } from "../src/test262/checkout.ts";
import { test262CollectFiles, test262ListFiles } from "../src/test262/files.ts";

test262Checkout();

const cacheContext = test262LoadCache();

if (!cacheContext.files.length) {
	const fileIterator = test262ListFiles();
	const files = await test262CollectFiles(fileIterator);

	cacheContext.files = files;
	test262PersistCache(cacheContext);
}
