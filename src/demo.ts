import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TradingAgentService } from "./agent-service.ts";

const directory = process.env.TRADING_AGENT_DATA_DIR ?? mkdtempSync(join(tmpdir(), "astra-demo-"));
const service = new TradingAgentService(directory);
const run = service.runSample({ strategyId: "opening-range-options", symbols: ["DEMOA", "DEMOB", "DEMOC"],
  includePremarket: false, requestId: "first-sample" });
console.log(JSON.stringify({ dataDirectory: directory, readiness: service.readiness(), run }, null, 2));
