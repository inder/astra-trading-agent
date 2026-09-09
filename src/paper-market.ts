import { RobinhoodMarketData, type EquityMarketQuote, validateSymbols } from "./market-data.ts";
import type { RobinhoodConnection } from "./broker-connection.ts";
import { loadOrbContracts, parseAvailableOrbCallQuotes, quoteOrbContracts } from "./option-source.ts";
import type { CallQuote, OrbCallContract } from "./orb-options.ts";

export interface PaperMarket {
  quotes(symbols: string[]): Promise<EquityMarketQuote[]>;
  bars(symbols: string[], start: number, end: number, extended: boolean): Promise<unknown>;
  calls(symbol: string, date: string): Promise<{ expiration: string; contracts: OrbCallContract[]; quotes: CallQuote[] }>;
  optionQuotes(ids: string[]): Promise<CallQuote[]>;
}
export class RobinhoodPaperMarket implements PaperMarket {
  #broker: RobinhoodConnection; #equities: RobinhoodMarketData;
  constructor(broker: RobinhoodConnection) { this.#broker = broker; this.#equities = new RobinhoodMarketData(broker); }
  quotes(symbols: string[]) { return this.#equities.quotes(symbols); }
  bars(symbols: string[], start: number, end: number, extended: boolean) {
    validateSymbols(symbols);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 86400000) throw new Error("Invalid history window");
    return this.#broker.read("get_equity_historicals", { symbols, interval: "minute", bounds: extended ? "extended" : "regular",
      adjustment_type: "split", start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString() });
  }
  async calls(symbol: string, date: string) {
    validateSymbols([symbol]);
    const source = {
      equityCallChains: (underlying_symbol: string) => this.#broker.read("get_option_chains", { underlying_symbol }),
      datedCallInstruments: (chain_id: string, expiration_dates: readonly string[], cursor?: string) =>
        this.#broker.read("get_option_instruments", { chain_id, expiration_dates: expiration_dates.join(","), type: "call", state: "active", tradability: "tradable", ...(cursor ? { cursor } : {}) }),
      optionQuotes: (instrument_ids: readonly string[]) => this.#broker.read("get_option_quotes", { instrument_ids }),
    };
    const catalog = await loadOrbContracts(source, symbol, date);
    return { ...catalog, quotes: await quoteOrbContracts(source, catalog.contracts) };
  }
  async optionQuotes(ids: string[]) {
    if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length || ids.some(id => !/^[a-f0-9-]{36}$/.test(id))) throw new Error("Invalid option IDs");
    return parseAvailableOrbCallQuotes(await this.#broker.read("get_option_quotes", { instrument_ids: ids }), ids, new Date().toISOString());
  }
}
