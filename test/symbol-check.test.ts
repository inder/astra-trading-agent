import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSymbols, type SymbolSource } from "../src/symbol-check.ts";
import { RobinhoodPaperMarket } from "../src/paper-market.ts";
import type { RobinhoodConnection } from "../src/broker-connection.ts";
import type { EquityMarketQuote } from "../src/market-data.ts";

// Invented tickers and dates. For a Monday 14 September 2026 trade the rule's expiry is Friday the 18th.
const MONDAY = "2026-09-14", TARGET = "2026-09-18";
const quote = (symbol: string): EquityMarketQuote => ({ symbol, price: 101.5, tradeAt: "2026-09-11T20:00:00.000Z", retrievedAt: "2026-09-11T21:48:00.000Z",
  ageMs: 6_480_000, fresh: false, regularSession: true, state: "active", bid: null, ask: null });
function source(listings: Record<string, string[] | Error>, unknown: string[] = []) {
  const calls = { batches: 0, singles: 0, chains: [] as string[] };
  const s: SymbolSource = {
    async quotes(symbols) {
      if (symbols.length > 1) calls.batches++; else calls.singles++;
      if (symbols.some(x => unknown.includes(x))) throw new Error("Incomplete or mismatched quote batch");
      return symbols.map(quote);
    },
    async listedExpirations(symbol) { calls.chains.push(symbol); const l = listings[symbol]; if (l instanceof Error) throw l; return l ?? []; },
  };
  return { s, calls };
}

test("each ticker gets its own verdict: usable, no qualifying expiry (no later expiry substituted), no options, failed read", async () => {
  const f = source({ DEMOA: ["2026-09-16", TARGET, "2026-09-25"], DEMOB: ["2026-09-16", "2026-09-25"], DEMOC: [], DEMOD: new Error("read failed") });
  const r = await checkSymbols(f.s, ["DEMOA", "DEMOB", "DEMOC", "DEMOD"], MONDAY);
  assert.equal(r.targetExpiration, TARGET); assert.equal(r.ordersSubmitted, 0);
  assert.deepEqual(r.symbols.map(x => [x.symbol, x.usable, x.problem, x.expiration]), [
    ["DEMOA", true, null, TARGET], ["DEMOB", false, "no_qualifying_expiry", null], ["DEMOC", false, "no_options", null], ["DEMOD", false, "check_failed", null]]);
  assert.deepEqual(r.symbols[0], { symbol: "DEMOA", usable: true, problem: null, price: 101.5, lastTradeAt: "2026-09-11T20:00:00.000Z", fresh: false, expiration: TARGET });
  assert.deepEqual(f.calls, { batches: 1, singles: 0, chains: ["DEMOA", "DEMOB", "DEMOC", "DEMOD"] });   // one batch, one chain read each
});
test("an unknown ticker fails alone: the rest are asked one by one, and it costs no chain read", async () => {
  const f = source({ DEMOA: [TARGET], DEMOB: [TARGET] }, ["NOPEX"]);
  const r = await checkSymbols(f.s, ["DEMOA", "NOPEX", "DEMOB"], MONDAY);
  assert.deepEqual(r.symbols.map(x => [x.symbol, x.problem]), [["DEMOA", null], ["NOPEX", "no_price"], ["DEMOB", null]]);
  assert.deepEqual(f.calls, { batches: 1, singles: 3, chains: ["DEMOA", "DEMOB"] });
});
test("bad ticker lists are rejected before any read", async () => {
  const f = source({});
  await assert.rejects(checkSymbols(f.s, ["DEMOA", "DEMOA"], MONDAY)); await assert.rejects(checkSymbols(f.s, ["../x"], MONDAY));
  assert.deepEqual(f.calls, { batches: 0, singles: 0, chains: [] });
});
test("listed expirations come from one option-chain read of standard, tradable chains only", async () => {
  const reads: [string, unknown][] = [];
  const chain = (over: Record<string, unknown>) => ({ id: "00000000-0000-0000-0000-000000000001", symbol: "DEMOA", can_open_position: true,
    trade_value_multiplier: "100", cash_component: null, expiration_dates: [TARGET, "2026-09-16"], underlying_instruments: [{ instrument: "x", symbol: "DEMOA" }], ...over });
  let chains: unknown[] = [chain({}), chain({ id: "00000000-0000-0000-0000-000000000002", trade_value_multiplier: "10", expiration_dates: ["2026-10-02"] }),
    chain({ id: "00000000-0000-0000-0000-000000000003", can_open_position: false, expiration_dates: ["2026-10-09"] })];
  let next: string | null = null;
  const broker = { read: async (tool: string, args: unknown) => { reads.push([tool, args]); return { data: { chains, next } }; } } as unknown as RobinhoodConnection;
  const market = new RobinhoodPaperMarket(broker);
  assert.deepEqual(await market.listedExpirations("DEMOA"), ["2026-09-16", TARGET]);
  assert.deepEqual(reads, [["get_option_chains", { underlying_symbol: "DEMOA" }]]);
  next = "https://example.invalid/?cursor=abc";   // a partial listing is not trusted
  await assert.rejects(market.listedExpirations("DEMOA"), /Incomplete option chains/);
  chains = []; next = null;
  assert.deepEqual(await market.listedExpirations("DEMOA"), []);
});
