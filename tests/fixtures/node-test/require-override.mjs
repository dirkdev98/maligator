const value = { answer: 42 };
export { value as "module.exports" };
const namespaceDefault = "namespace default";
// oxlint-disable-next-line import/no-default-export -- The fixture distinguishes require's override from its ESM default.
export { namespaceDefault as default };
