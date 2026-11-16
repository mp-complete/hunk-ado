// Offline fixture for a real Hunk TUI smoke test. Never contacts ADO or reads credentials.
import type { ExtensionFactory } from "hunkdiff/extension";
import { createAdoExtension } from "../src/index.ts";
import { PATCH, iterations, json, metadata } from "./fixtures.ts";

const extension = createAdoExtension({
  env: { HUNK_ADO_TOKEN: "offline-fixture" },
  fetchImpl: async (url) => json(String(url).includes("/iterations?") ? iterations() : metadata()),
  run: async ({ args }) => Buffer.from(args.includes("diff") ? PATCH : args.includes("cat-file") ? "commit" : ""),
});
const smoke: ExtensionFactory = (hunk) => {
  hunk.configureSession({ viewPreferences: "transient" });
  return extension(hunk);
};
export default smoke;
