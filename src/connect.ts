import { RobinhoodConnection } from "./broker-connection.ts";

// Attended diagnostic only: never reads account numbers, portfolios or positions.
// The MCP tool offers the same onboarding flow conversationally.
const connection = new RobinhoodConnection();
let stopping = false;
const stop = async () => { stopping = true; await connection.close(); };
process.once("SIGINT", () => { void stop(); }); process.once("SIGTERM", () => { void stop(); });
try {
  const result = await connection.begin() as { authorizationUrl?: string };
  if (result.authorizationUrl) console.log(`Open in your desktop browser on this machine:\n${result.authorizationUrl}\nWaiting for authorization. No orders can be submitted.`);
  while (!stopping && ["awaiting_authorization", "verifying"].includes(connection.status().state))
    await new Promise(ok => setTimeout(ok, 500));
  console.log(JSON.stringify(connection.status()));
  if (!stopping && connection.status().state !== "connected") process.exitCode = 1;
  if (connection.status().state === "connected") console.log("Connection verified. This diagnostic now disconnects; authorize in your running MCP server for ongoing market reads.");
} catch { console.error("Connection failed. Check connectivity and retry. No orders submitted."); process.exitCode = 1; }
finally { await connection.close(); }
