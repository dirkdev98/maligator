const checks = [typeof Temporal === "undefined"];
console.log("RESULT " + checks.filter(Boolean).length + "/" + checks.length);
