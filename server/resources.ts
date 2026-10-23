import type { NextFunction, Request, Response } from "express";
import { HttpError } from "./errors.js";
import type { Telemetry } from "./telemetry.js";

export function positiveInteger(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error("Resource limits must be positive integers");
  return parsed;
}

export function admission(limit: number, operation = "storage", telemetry?: Telemetry) {
  let active = 0;
  return async <T>(run: () => Promise<T>) => {
    if (active >= limit) {
      telemetry?.operation(operation, "reject");
      throw new HttpError(429, "Storage operation capacity reached. Retry shortly.");
    }
    active++;
    telemetry?.operation(operation, "start");
    const started = performance.now();
    let completed = false;
    try {
      const result = await run();
      completed = true;
      return result;
    } finally {
      active--;
      telemetry?.operation(operation, completed ? "complete" : "fail");
      if (process.env.NODE_ENV === "production")
        console.info(
          JSON.stringify({
            event: "storage",
            operation,
            active,
            completed,
            duration_ms: Math.round(performance.now() - started),
          }),
        );
    }
  };
}

export function requestSignal(req: Request, timeout?: number) {
  const response = req.res;
  const controller = new AbortController();
  const close = () => {
    if (!response?.writableFinished) controller.abort();
  };
  response?.once("close", close);
  req.once("aborted", close);
  if (req.aborted || response?.destroyed) controller.abort();
  const signal =
    timeout === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]);
  return {
    signal,
    dispose: () => {
      response?.off("close", close);
      req.off("aborted", close);
    },
  };
}

export function originGuard(req: Request, _res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  let rejected = req.get("sec-fetch-site") === "cross-site";
  const origin = req.get("origin");
  if (origin) {
    try {
      const url = new URL(origin);
      rejected ||= !["http:", "https:"].includes(url.protocol) || url.host !== req.get("host");
    } catch {
      rejected = true;
    }
  }
  next(rejected ? new HttpError(403, "Cross-origin changes are not permitted") : undefined);
}
