import { OrbOptionsEngine, preferredWeeklyExpiration, selectOrbCall, type OrbIntent, type OrbOptionsConfig } from "./orb-options.ts";
import { openingRangeConfig, type StrategySetupInput } from "./orb-config.ts";
import type { PaperFactory } from "./paper-runtime.ts";
import { OrbPaperRuntime } from "./orb-paper-runtime.ts";

export interface SampleEvent { sequence: number; type: string; data: unknown }
export interface SampleResult { events: SampleEvent[]; summary: Record<string, unknown> }
export interface AgentStrategy {
  id: string; version: string; name: string; description: string;
  capabilities: readonly string[];
  preview(input: StrategySetupInput): unknown;
  runSample(config: unknown): SampleResult;
  paperFactory?: PaperFactory;
}

// Transport-independent plug-in contract: no chat, filesystem, credentials or broker.

export const openingRangeStrategy: AgentStrategy = {
  id: "opening-range-options", version: "0.3.0", name: "Opening-range call options",
  description: "Deterministic strict opening-range and drive-then-balance call-option strategy.",
  capabilities: ["synthetic_sample", "configuration_preview", "continuous_paper"],
  paperFactory: (config, market, clock, checkpoint) => new OrbPaperRuntime(config, market, clock, checkpoint),
  preview: input => openingRangeConfig(input),
  runSample(raw): SampleResult {
    const engine = new OrbOptionsEngine(raw as OrbOptionsConfig), config = engine.config;
    const events: SampleEvent[] = [];
    const emit = (type: string, data: unknown) => events.push({ sequence: events.length + 1, type, data });
    // Deliberately synthetic fixtures, not today's prices or a performance backtest.
    const start = Date.parse("2026-09-08T13:30:00Z");
    emit("sample_started", { dataset: "synthetic-orb-v1", marketDate: "2026-09-08", ordersSubmitted: 0 });
    for (const symbol of config.symbols) {
      const range = { low: 100, high: 101, startMs: start - config.includePremarketLeadMinutes * 60000, endMs: start + 120000 };
      engine.setRange(symbol, range); emit("opening_range", { symbol, ...range });
    }
    let committedCents = 0;
    // The sample's invented chain lists this Friday and next; the live expiry rule picks among them.
    const expiration = preferredWeeklyExpiration(["2026-09-11", "2026-09-18"], config.date);
    if (!expiration) throw new Error("Sample chain has no qualifying expiry");
    const handle = (intent: OrbIntent) => {
      emit("strategy_intent", intent);
      if (intent.kind === "enter_calls") {
        const index = config.symbols.indexOf(intent.symbol);
        const id = `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`;
        const at = new Date(intent.at).toISOString();
        const selection = selectOrbCall([{
          id, symbol: intent.symbol, expiration, strike: 101, multiplier: 100,
          tickBelow: .01, tickAbove: .05, tickCutoff: 3, selloutAt: `${expiration}T19:00:00Z`,
        }], [{ id, bid: 3.9, ask: 4, askSize: 10, updatedAt: at, retrievedAt: at }],
        intent.symbol, expiration, intent.stockPrice, config, intent.at);
        if (!selection) { engine.failEntry(intent.symbol); emit("entry_skipped", { symbol: intent.symbol, reason: "selection_failed" }); return; }
        committedCents += selection.committedCents;
        engine.confirmEntry(intent.symbol, id, selection.quantity, intent.stockPrice);
        emit("simulated_entry", { symbol: intent.symbol, ...selection, synthetic: true });
      } else {
        engine.confirmSale(intent.symbol, intent.quantity);
        emit("simulated_sale", { ...intent, synthetic: true, fillPrice: null });
      }
    };
    // The first name exercises all four trims; the second exercises the stop.
    // Additional simultaneous breakouts exercise the shared two-position cap.
    for (let step = 0; step <= 4; step++) {
      const at = start + 120000 + step * 1000;
      for (const [index, symbol] of config.symbols.entries()) {
        const price = step === 0 ? 101.1 : index === 1 ? 99.8 : 101.1 * (1 + .05 * step);
        const before = engine.snapshot().symbols[symbol]!.status;
        emit("synthetic_quote", { symbol, price, at });
        for (const intent of engine.observe(symbol, price, at)) handle(intent);
        if (before !== "skipped" && engine.snapshot().symbols[symbol]!.status === "skipped")
          emit("entry_skipped", { symbol, reason: "maximum_positions" });
      }
    }
    const summary = { mode: "synthetic_sample", dataset: "synthetic-orb-v1", ordersSubmitted: 0,
      committedCents, pnl: null, pnlExplanation: "No option exit-price model: P&L is intentionally unavailable.",
      snapshot: engine.snapshot(), limitations: ["Invented prices and assumed fills; not real market data.",
        "Exercises strict breakout, sizing, position cap, trims and stop; not balance-detector or broker validation."] };
    emit("sample_completed", summary);
    return { events, summary };
  },
};

export const agentStrategies: readonly AgentStrategy[] = [openingRangeStrategy];
