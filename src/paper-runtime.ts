import type { PaperMarket } from "./paper-market.ts";

export interface PaperEvent { type: string; data: unknown }
export interface PaperPosition { symbol: string; contractId: string; strike: number; expiration: string; quantity: number;
  entryPrice: number; entryStockPrice: number; markBid: number | null; markAt: string | null; stop: number;
  stage: "initial" | "breakeven"; backstop: number; }
export interface PaperControl { symbol: string; quantity: number; expectedQuantity: number; action: "trim" | "close" }
/** A step that failed part-way, carrying the events it produced first so the halt record can keep them. */
export class StepError extends Error {
  readonly events: PaperEvent[];
  constructor(cause: unknown, events: PaperEvent[]) { super(cause instanceof Error ? cause.message : String(cause), { cause }); this.events = events; }
}
export interface PaperRuntime {
  step(): Promise<PaperEvent[]>;
  control(command: PaperControl): Promise<PaperEvent[]>;
  checkpoint(): unknown;
  /** Milliseconds between ticks; the controller uses 1000 when a runtime does not say. */
  readonly pollMs?: number;
  view(): { positions: PaperPosition[]; committedCents: number; realizedPnlCents: number;
    unrealizedPnlCents: number | null; lastQuoteAt: string | null; complete: boolean; dataGapSince?: string | null; detail: unknown };
}
export type PaperFactory = (config: unknown, market: PaperMarket, clock: () => number, checkpoint?: unknown) => PaperRuntime;
