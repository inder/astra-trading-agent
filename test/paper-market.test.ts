import { test } from "node:test";
import assert from "node:assert/strict";
import { loadOrbContracts, parseAvailableOrbCallQuotes, quoteOrbContracts, type OrbOptionSource } from "../src/option-source.ts";
import { RobinhoodPaperMarket } from "../src/paper-market.ts";
import type { RobinhoodConnection } from "../src/broker-connection.ts";
const chainId = "00000000-0000-0000-0000-000000000001", contractId = "00000000-0000-0000-0000-000000000002";
const instrument = { id: contractId, chain_id: chainId, chain_symbol: "DEMOA", expiration_date: "2026-09-11", type: "call", state: "active",
  tradability: "tradable", underlying_type: "equity", trade_value_multiplier: "100", strike_price: "105", min_ticks: { below_tick: ".01", above_tick: ".05", cutoff_price: "3" }, sellout_datetime: "2026-09-11T19:30:00Z" };
function source() {
  const calls: unknown[] = [];
  const provider: OrbOptionSource = {
    async equityCallChains(symbol) { calls.push(["chains", symbol]); return { data: { chains: [{ id: chainId, symbol, can_open_position: true, trade_value_multiplier: "100", cash_component: "0",
      expiration_dates: ["2026-09-09", "2026-09-11"], underlying_instruments: [{ instrument: "synthetic-equity-id", symbol }] }] } }; },
    async datedCallInstruments(chain, expiries, cursor) { calls.push(["instruments", chain, expiries, cursor]); return { data: { instruments: [instrument], next: null } }; },
    async optionQuotes(ids) { calls.push(["quotes", ids]); return { data: { results: ids.map(id => ({ quote: { instrument_id: id, bid_price: "3.9", ask_price: "4", ask_size: 20, updated_at: "2026-09-08T13:32:01Z" } })) } }; },
  }; return { provider, calls };
}
test("option catalog selects Friday and accepts only standard tradable calls", async () => {
  const { provider } = source(); const catalog = await loadOrbContracts(provider, "DEMOA", "2026-09-08");
  assert.equal(catalog.expiration, "2026-09-11"); assert.equal(catalog.contracts[0]?.id, contractId);
  provider.datedCallInstruments = async () => ({ data: { instruments: [{ ...instrument, type: "put" }] } });
  await assert.rejects(loadOrbContracts(provider, "DEMOA", "2026-09-08"), /Missing/);
});
test("option quote sizes sent as strings are coerced, so they can pass the integer size checks", () => {
  const at = "2026-09-08T15:00:00.000Z", id = "00000000-0000-0000-0000-000000000001";
  const [quote] = parseAvailableOrbCallQuotes({ data: { results: [{ quote: { instrument_id: id, bid_price: "1.00", ask_price: "1.05", ask_size: "20", updated_at: at } }] } }, [id], at);
  assert.equal(quote!.askSize, 20);
});
test("option pagination, duplicate identities and unexpected quotes fail closed", async () => {
  const { provider } = source();
  provider.datedCallInstruments = async () => ({ data: { instruments: [], next: "https://example.invalid/page?cursor=repeat" } });
  await assert.rejects(loadOrbContracts(provider, "DEMOA", "2026-09-08"), /repeated/);
  provider.datedCallInstruments = async () => ({ data: { instruments: [instrument, instrument] } });
  await assert.rejects(loadOrbContracts(provider, "DEMOA", "2026-09-08"), /duplicate/);
  assert.throws(() => parseAvailableOrbCallQuotes({ data: { results: [{ quote: { instrument_id: chainId } }] } }, [contractId], new Date().toISOString()), /foreign/);
});
test("option retrieval timestamp follows the completed request", async () => {
  const { provider } = source(); let clock = Date.parse("2026-09-08T13:32:00Z");
  const catalog = await loadOrbContracts(provider, "DEMOA", "2026-09-08"), original = provider.optionQuotes;
  provider.optionQuotes = async ids => { clock += 1000; return original(ids); };
  const quotes = await quoteOrbContracts(provider, catalog.contracts, () => clock);
  assert.equal(quotes[0]?.retrievedAt, "2026-09-08T13:32:01.000Z");
});
test("paper adapter maps requests to bounded read-only provider operations", async () => {
  const { provider, calls } = source(); const names: string[] = [];
  const broker = { async read(name: string, args: any) {
    names.push(name);
    if (name === "get_option_chains") return provider.equityCallChains(args.underlying_symbol);
    if (name === "get_option_instruments") { assert.equal(args.type, "call"); assert.equal(args.expiration_dates, "2026-09-11"); return provider.datedCallInstruments(args.chain_id, [args.expiration_dates]); }
    if (name === "get_option_quotes") return provider.optionQuotes(args.instrument_ids);
    if (name === "get_equity_historicals") { assert.equal(args.interval, "minute"); assert.equal(args.bounds, "extended"); return { data: { results: [] } }; }
    throw new Error("Unexpected operation");
  } } as unknown as RobinhoodConnection;
  const market = new RobinhoodPaperMarket(broker);
  const catalog = await market.calls("DEMOA", "2026-09-08"); assert.equal(catalog.quotes.length, 1);
  await market.optionQuotes([contractId]); await market.bars(["DEMOA"], 0, 120000, true);
  assert.throws(() => market.bars(["DEMOA"], 0, 86400001, false));
  await assert.rejects(market.optionQuotes([contractId, contractId]));
  assert.deepEqual(new Set(names), new Set(["get_option_chains", "get_option_instruments", "get_option_quotes", "get_equity_historicals"]));
  assert.ok(calls.length >= 4);
});
