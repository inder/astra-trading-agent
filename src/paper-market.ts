import { RobinhoodMarketData, type EquityMarketQuote, validateSymbols } from "./market-data.ts";
import type { RobinhoodConnection } from "./broker-connection.ts";
import { loadOrbContracts, parseAvailableOrbCallQuotes } from "./option-source.ts";
import type { CallQuote, OrbCallContract } from "./orb-options.ts";

export interface OptionCatalog { expiration: string; contracts: OrbCallContract[] }
export interface PaperMarket {
  quotes(symbols: string[]): Promise<EquityMarketQuote[]>;
  bars(symbols: string[], start: number, end: number, extended: boolean): Promise<unknown>;
  /** The day's call catalog for the target expiry: instruments only, no quotes (the runtime loads it once per session). */
  contracts(symbol: string, date: string): Promise<OptionCatalog>;
  /** Quotes for at most 20 contracts (the provider's per-request limit). */
  optionQuotes(ids: string[]): Promise<CallQuote[]>;
}
export class RobinhoodPaperMarket implements PaperMarket {
  #broker: RobinhoodConnection; #equities: RobinhoodMarketData; #clock: () => number;
  constructor(broker: RobinhoodConnection, clock = Date.now) { this.#broker = broker; this.#equities = new RobinhoodMarketData(broker); this.#clock = clock; }
  quotes(symbols: string[]) { return this.#equities.quotes(symbols); }
  bars(symbols: string[], start: number, end: number, extended: boolean) {
    validateSymbols(symbols);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 86400000) throw new Error("Invalid history window");
    return this.#broker.read("get_equity_historicals", { symbols, interval: "minute", bounds: extended ? "extended" : "regular",
      adjustment_type: "split", start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString() });
  }
  async contracts(symbol: string, date: string) {
    validateSymbols([symbol]);
    return loadOrbContracts({
      equityCallChains: (underlying_symbol: string) => this.#broker.read("get_option_chains", { underlying_symbol }),
      datedCallInstruments: (chain_id: string, expiration_dates: readonly string[], cursor?: string) =>
        this.#broker.read("get_option_instruments", { chain_id, expiration_dates: expiration_dates.join(","), type: "call", state: "active", tradability: "tradable", ...(cursor ? { cursor } : {}) }),
      optionQuotes: (instrument_ids: readonly string[]) => this.#broker.read("get_option_quotes", { instrument_ids }),
    }, symbol, date);
  }
  async optionQuotes(ids: string[]) {
    if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length || ids.some(id => !/^[a-f0-9-]{36}$/.test(id))) throw new Error("Invalid option IDs");
    // Stamped when the answer arrives, not when it was asked.
    const raw = await this.#broker.read("get_option_quotes", { instrument_ids: ids });
    return parseAvailableOrbCallQuotes(raw, ids, new Date(this.#clock()).toISOString());
  }
}
