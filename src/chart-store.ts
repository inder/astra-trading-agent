import type { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type { MinuteBar } from "./intraday-bars.ts";

/** Minute history the chart has seen, kept so a chart left open for hours — or reopened days later — shows more
 *  than the few days one Robinhood read can return.
 *
 *  Two kinds of row, and only one may overwrite the other. An OFFICIAL bar is Robinhood's own minute bar for a minute
 *  that had already ended when it was read. A PROVISIONAL bar is built here from polled quotes while its minute is
 *  live: polling every few seconds sees the last trade, not every trade, so its high and low can understate the
 *  minute. Official always replaces provisional; provisional never replaces official. That is what stops a missed
 *  tick from leaving a wrong candle in the history for good.
 *
 *  Market data only: no account, position or order is ever written here.
 *
 *  `node:sqlite` is built into Node 24 and still flagged experimental, so it prints one warning at startup (to stderr,
 *  which MCP's stdio transport does not use). It is loaded only when a chart is first opened, so a process that never
 *  charts never prints it, and it is confined to this file so an API change is a one-file fix. */
export class ChartStore {
  #db: DatabaseSync;
  #putOfficial; #putTick; #range; #officialCount; #prune; #dropProvisional; #markComplete; #isComplete; #pruneComplete;
  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      // Created owner-only before SQLite opens it: SQLite gives its -wal and -shm files the database file's mode.
      closeSync(openSync(path, "a", 0o600));
      chmodSync(path, 0o600);                                     // and tightened if an older one was not
    }
    const { DatabaseSync: Database } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    // Several Astra processes can share one data directory (one per chat client). Without a busy timeout a write
    // that meets another process's write fails at once instead of waiting its turn.
    this.#db = new Database(path, { timeout: 2000 });
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS minute_bars (
        symbol TEXT NOT NULL, t INTEGER NOT NULL,
        o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v INTEGER NOT NULL,
        official INTEGER NOT NULL CHECK (official IN (0, 1)),
        -- When the trade behind a provisional close happened, so a late-arriving older quote cannot move it back.
        tick_at INTEGER,
        PRIMARY KEY (symbol, t)
      ) WITHOUT ROWID;
      -- Sessions whose minute bars were read after the session closed, so the store holds all of them. Holding SOME
      -- official bars proves nothing: a chart closed at 11:00 leaves 9:30-11:00 behind, and that day must still be
      -- read in full later.
      CREATE TABLE IF NOT EXISTS complete_sessions (
        symbol TEXT NOT NULL, date TEXT NOT NULL, close INTEGER NOT NULL, PRIMARY KEY (symbol, date)
      ) WITHOUT ROWID;`)
    this.#putOfficial = this.#db.prepare(`INSERT INTO minute_bars (symbol, t, o, h, l, c, v, official, tick_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL)
      ON CONFLICT (symbol, t) DO UPDATE SET o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c,
        v = excluded.v, official = 1, tick_at = NULL`);
    this.#putTick = this.#db.prepare(`INSERT INTO minute_bars (symbol, t, o, h, l, c, v, official, tick_at)
      VALUES (?1, ?2, ?3, ?3, ?3, ?3, 0, 0, ?4)
      ON CONFLICT (symbol, t) DO UPDATE SET h = max(h, excluded.h), l = min(l, excluded.l),
        c = CASE WHEN excluded.tick_at >= tick_at THEN excluded.c ELSE c END,
        tick_at = max(tick_at, excluded.tick_at)
      WHERE official = 0
      RETURNING t, o, h, l, c, v`);
    this.#range = this.#db.prepare(`SELECT t, o, h, l, c, v FROM minute_bars WHERE symbol = ? AND t >= ? AND t < ? ORDER BY t`);
    this.#officialCount = this.#db.prepare(`SELECT count(*) AS n FROM minute_bars WHERE symbol = ? AND t >= ? AND t < ? AND official = 1`);
    this.#prune = this.#db.prepare(`DELETE FROM minute_bars WHERE t < ?`);
    this.#markComplete = this.#db.prepare(`INSERT OR IGNORE INTO complete_sessions (symbol, date, close) VALUES (?, ?, ?)`);
    this.#isComplete = this.#db.prepare(`SELECT 1 AS ok FROM complete_sessions WHERE symbol = ? AND date = ?`);
    this.#pruneComplete = this.#db.prepare(`DELETE FROM complete_sessions WHERE close < ?`);
    this.#dropProvisional = this.#db.prepare(`DELETE FROM minute_bars WHERE symbol = ? AND t >= ? AND t < ? AND official = 0`);
  }
  /** Stores Robinhood's bars for the settled window [from, to) as official, in one transaction. Provisional rows in
   *  that window that Robinhood has no bar for go too: Robinhood answered for those minutes, and a minute it left out
   *  (or sent as gap-fill) had no trade to chart, so a quote-built guess there must not outlive the answer. */
  putOfficial(symbol: string, from: number, to: number, bars: readonly MinuteBar[]) {
    this.#db.exec("BEGIN");
    try {
      this.#dropProvisional.run(symbol, from, to);
      for (const b of bars) if (b.t >= from && b.t < to) this.#putOfficial.run(symbol, b.t, b.o, b.h, b.l, b.c, b.v);
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  /** Folds one traded price into its minute's provisional bar. Returns the bar as it now stands, or null when that
   *  minute already holds an official bar, which a quote may not change. */
  putTick(symbol: string, minute: number, price: number, tradeAt: number): MinuteBar | null {
    const row = this.#putTick.get(symbol, minute, price, tradeAt) as MinuteBar | undefined;
    return row ? { ...row } : null;
  }
  bars(symbol: string, from: number, to: number): MinuteBar[] {
    return (this.#range.all(symbol, from, to) as unknown as MinuteBar[]).map(r => ({ ...r }));
  }
  officialCount(symbol: string, from: number, to: number): number {
    return Number((this.#officialCount.get(symbol, from, to) as { n: number }).n);
  }
  /** Records that `date`'s bars were read after its close, so the store holds the whole session. */
  markComplete(symbol: string, date: string, close: number) { this.#markComplete.run(symbol, date, close); }
  isComplete(symbol: string, date: string): boolean { return this.#isComplete.get(symbol, date) !== undefined; }
  /** Forgets every bar, and every completeness record, older than `before`. */
  prune(before: number) { this.#prune.run(before); this.#pruneComplete.run(before); }
  close() { if (this.#db.isOpen) this.#db.close(); }
}
