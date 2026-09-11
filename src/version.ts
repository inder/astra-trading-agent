import { readFileSync } from "node:fs";

/** The package version: the one source for what the MCP server and its clients report. */
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
