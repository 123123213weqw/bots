/** Small, dependency-free building blocks. Unit-tested in tests/. */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Remembers recently seen ids; returns true only the first time. */
export class Deduper {
  #ttlMs: number;
  #maxItems: number;
  #seen = new Map<string, number>();

  constructor(ttlMs = 15 * 60_000, maxItems = 20_000) {
    this.#ttlMs = ttlMs;
    this.#maxItems = maxItems;
  }

  firstSight(key: string, now = Date.now()): boolean {
    const previous = this.#seen.get(key);
    if (previous !== undefined && now - previous <= this.#ttlMs) return false;
    this.#seen.set(key, now);
    this.#prune(now);
    return true;
  }

  get size(): number {
    return this.#seen.size;
  }

  #prune(now: number): void {
    if (this.#seen.size > this.#maxItems) {
      this.#seen.clear();
      return;
    }
    for (const [key, at] of this.#seen) {
      if (now - at > this.#ttlMs) this.#seen.delete(key);
    }
  }
}

/**
 * Group messages arrive as "@_user_1 hello"; drop the placeholders.
 *
 * "@_all" (mention everyone) is a separator too and is NOT matched by the
 * @_user_N form, so a message "@_all ship it" would otherwise reach the handler
 * with the token attached and every command parser would miss.
 */
export function stripMentions(text: string): string {
  return text.replace(/@_user_\d+\s*|@_all\s*/g, "").trim();
}

/** Split text into platform-sized chunks without breaking surrogate pairs. */
export function chunk(text: string, max = 4000): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = max;
    // Do not split a surrogate pair in half.
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Bounded concurrency queue. The platform gives an event handler 3 seconds, so
 * work is handed here and the handler returns immediately.
 */
export class Queue {
  #limit: number;
  #active = 0;
  #pending: Array<() => void> = [];
  #idleWaiters: Array<() => void> = [];

  constructor(limit = 8) {
    this.#limit = limit;
  }

  get active(): number {
    return this.#active;
  }

  get pending(): number {
    return this.#pending.length;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.#active += 1;
        task()
          .then(resolve, reject)
          .finally(() => {
            this.#active -= 1;
            const next = this.#pending.shift();
            if (next) next();
            else this.#settleIdle();
          });
      };
      if (this.#active < this.#limit) start();
      else this.#pending.push(start);
    });
  }

  whenIdle(): Promise<void> {
    if (this.#active === 0 && this.#pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  #settleIdle(): void {
    if (this.#pending.length > 0) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** Cache of uploaded media, keyed by content hash. */
export class LruCache<V> {
  #max: number;
  #map = new Map<string, V>();

  constructor(max = 100) {
    this.#max = max;
  }

  get(key: string): V | undefined {
    const value = this.#map.get(key);
    if (value !== undefined) {
      this.#map.delete(key);
      this.#map.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    if (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next();
      if (!oldest.done) this.#map.delete(oldest.value);
    }
  }

  delete(key: string): boolean {
    return this.#map.delete(key);
  }

  get size(): number {
    return this.#map.size;
  }
}

/**
 * True when this module is the process entry point.
 *
 * Modules that start work at import time (network calls, timers, reading the
 * environment) become untestable and surprising: importing them for a unit test
 * fires the side effect. Guard those modules with this.
 */
export function isEntryPoint(
  importMetaUrl: string,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (!argv1) return false;
  try {
    return fileURLToPath(importMetaUrl) === realpathSync(argv1);
  } catch {
    return false;
  }
}
