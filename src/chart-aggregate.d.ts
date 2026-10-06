import type { MinuteBar } from "./intraday-bars.ts";

export interface SessionBounds { open: number; close: number }
export function bucketStart(t: number, minutes: number, sessions: SessionBounds[]): number | null;
export function aggregate(bars: MinuteBar[], minutes: number, sessions: SessionBounds[]): MinuteBar[];
export function dayCandle(bars: MinuteBar[], session: SessionBounds): Omit<MinuteBar, "t"> | null;
export function mergeBars(bars: MinuteBar[], incoming: MinuteBar[]): MinuteBar[];
