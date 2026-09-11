import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TradingAgentService } from "../src/agent-service.ts";
import { sessionTimes } from "../src/orb-paper-runtime.ts";
import type { PaperMarket } from "../src/paper-market.ts";

// Shared by the unit suite and the real-browser e2e suite: invented prices, injected clock, no broker.
export const date = "2026-09-08";
export const { open, close } = sessionTimes(date);
export const id = (i: number) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
export const setup = { runId: "paper-one", strategyId: "opening-range-options", date, symbols: ["DEMOA", "DEMOB", "DEMOC"], includePremarket: false };
export function fixture(t: TestContext, symbols = setup.symbols) {
  const directory = mkdtempSync(join(tmpdir(), "astra-paper-test-"));
  let now = open - 1000, bid = 3.9, stockAge = 0, optionAge = 0, fail = false;
  const prices: Record<string, number> = Object.fromEntries(symbols.map(s => [s, 104]));
  const market: PaperMarket = {
    async quotes(requested) {
      if (fail) throw new Error("test-only outage");
      return requested.map(symbol => ({ symbol, price: prices[symbol]!, tradeAt: new Date(now - stockAge).toISOString(), retrievedAt: new Date(now).toISOString(),
        ageMs: stockAge, fresh: stockAge <= 5000, regularSession: true, state: "active", bid: null, ask: null }));
    },
    async bars(requested, start, end, extended) {
      return { data: { results: requested.map(symbol => ({ symbol, interval: "minute", bounds: extended ? "extended" : "regular",
        bars: Array.from({ length: (end - start) / 60000 }, (_, i) => ({ begins_at: new Date(start + i * 60000).toISOString(),
          open_price: "102", close_price: "104", high_price: "105", low_price: "100", volume: "1000", session: start + i * 60000 < open ? "pre" : "reg" })) })) } };
    },
    async calls(symbol) {
      const contractId = id(symbols.indexOf(symbol) + 1);
      return { expiration: "2026-09-11", contracts: [{ id: contractId, symbol, expiration: "2026-09-11", strike: 105, multiplier: 100,
        tickBelow: .01, tickAbove: .05, tickCutoff: 3, selloutAt: "2026-09-11T19:30:00Z" }],
        quotes: [{ id: contractId, bid: 3.9, ask: 4, askSize: 20, updatedAt: new Date(now - optionAge).toISOString(), retrievedAt: new Date(now).toISOString() }] };
    },
    async optionQuotes(ids) { return ids.map(id => ({ id, bid, ask: bid + .1, askSize: 20, updatedAt: new Date(now - optionAge).toISOString(), retrievedAt: new Date(now).toISOString() })); },
  };
  const options = { market, clock: () => now, ready: () => true, auto: false };
  const service = new TradingAgentService(directory, undefined, undefined, options);
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, service, market, options, prices, setTime: (v: number) => { now = v; }, advance: (v = 1000) => { now += v; },
    setBid: (v: number) => { bid = v; }, staleStock: (v: number) => { stockAge = v; }, staleOption: (v: number) => { optionAge = v; },
    outage: () => { fail = true; } };
}
export async function entered(f: ReturnType<typeof fixture>, symbols = setup.symbols) {
  f.service.paper.configure({ ...setup, symbols }); await f.service.paper.start(setup.runId);
  f.setTime(open + 120000); await f.service.paper.tick(setup.runId);
  f.advance(); f.prices[symbols[0]!] = 106; await f.service.paper.tick(setup.runId);
  assert.equal(f.service.paper.status(setup.runId).view.positions[0]?.quantity, 4);
}
