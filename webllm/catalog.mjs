import catalog from "./catalog.json";

const libraries = new Map(catalog.libraries.map((library) => [library.file, library]));
export const models = catalog.models.map((model) => {
  const library = libraries.get(model.wasmFile);
  return { ...model, wasmUrl: library.url, wasmSha256: library.sha256, wasmBytes: library.bytes };
});
