import type { PaperMarket } from "./paper-market.ts";

export interface PaperEvent { type: string; data: unknown }
export interface PaperPosition { symbol: string; contractId: string; strike: number; expiration: string; quantity: number;
  entryPrice: number; entryStockPrice: number; markBid: number | null; markAt: string | null; stop: number;
  stage: "initial" | "breakeven"; backstop: number; }
export interface PaperControl { symbol: string; quantity: number; expectedQuantity: number; action: "trim" | "close" }
export interface PaperRuntime {
  step(): Promise<PaperEvent[]>;
  control(command: PaperControl): Promise<PaperEvent[]>;
  checkpoint(): unknown;
  view(): { positions: PaperPosition[]; committedCents: number; realizedPnlCents: number;
    unrealizedPnlCents: number | null; lastQuoteAt: string | null; complete: boolean; detail: unknown };
}
export type PaperFactory = (config: unknown, market: PaperMarket, clock: () => number, checkpoint?: unknown) => PaperRuntime;
