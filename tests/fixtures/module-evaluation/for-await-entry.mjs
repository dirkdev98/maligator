let sum = 0;
for await (const value of [Promise.resolve(1), 2]) sum += value;
if (sum !== 3) throw new Error("top-level for await did not complete");
console.log("RESULT 1/1");
