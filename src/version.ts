import { readFileSync } from "node:fs";

/** The package version: the one source for what the MCP server and its clients report. */
const version: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
if (typeof version !== "string" || !version) throw new Error("package.json has no version");
export const VERSION: string = version;
