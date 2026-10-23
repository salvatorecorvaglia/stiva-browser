import type { NextFunction, Request, Response } from "express";

const buckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 5, 15, 60, 120];
const methods = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]);
function label(value: string) {
  return JSON.stringify(value);
}
interface HttpSample {
  count: number;
  seconds: number;
  buckets: number[];
}
interface Operation {
  active: number;
  peak: number;
  completed: number;
  failed: number;
  rejected: number;
}

/** Labels are route templates and fixed operation names, never user keys or endpoint URLs. */
export class Telemetry {
  private http = new Map<string, HttpSample>();
  private operations = new Map<string, Operation>();
  private cleanupFailures = 0;
  readonly httpMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const started = performance.now();
    let recorded = false;
    const done = () => {
      if (recorded) return;
      recorded = true;
      const seconds = (performance.now() - started) / 1000;
      const route = typeof req.route?.path === "string" ? req.route.path : "unmatched";
      const method = methods.has(req.method) ? req.method : "OTHER";
      const status = res.writableFinished ? `${Math.floor(res.statusCode / 100)}xx` : "aborted";
      const labels = `method=${label(method)},route=${label(route)},status_class=${label(status)}`;
      const sample = this.http.get(labels) ?? {
        count: 0,
        seconds: 0,
        buckets: buckets.map(() => 0),
      };
      sample.count++;
      sample.seconds += seconds;
      for (let i = 0; i < buckets.length; i++) if (seconds <= buckets[i]) sample.buckets[i]++;
      this.http.set(labels, sample);
      if (process.env.NODE_ENV === "production")
        console.info(
          JSON.stringify({
            event: "http",
            method,
            route,
            status: res.statusCode,
            completed: res.writableFinished,
            duration_ms: Math.round(seconds * 1000),
          }),
        );
    };
    res.once("finish", done);
    res.once("close", done);
    next();
  };
  operation(name: string, event: "start" | "complete" | "fail" | "reject") {
    const value = this.operations.get(name) ?? {
      active: 0,
      peak: 0,
      completed: 0,
      failed: 0,
      rejected: 0,
    };
    if (event === "start") {
      value.active++;
      value.peak = Math.max(value.peak, value.active);
    } else if (event === "reject") value.rejected++;
    else {
      value.active--;
      if (event === "complete") value.completed++;
      else value.failed++;
    }
    this.operations.set(name, value);
  }
  cleanupFailed() {
    this.cleanupFailures++;
  }
  render() {
    const lines = [
      "# TYPE stiva_http_requests_total counter",
      "# TYPE stiva_http_request_duration_seconds histogram",
      "# TYPE stiva_storage_active gauge",
      "# TYPE stiva_storage_peak gauge",
      "# TYPE stiva_storage_completed_total counter",
      "# TYPE stiva_storage_failed_total counter",
      "# TYPE stiva_storage_rejected_total counter",
    ];
    for (const [labels, value] of this.http) {
      lines.push(`stiva_http_requests_total{${labels}} ${value.count}`);
      buckets.forEach((bound, index) => {
        lines.push(
          `stiva_http_request_duration_seconds_bucket{${labels},le="${bound}"} ${value.buckets[index]}`,
        );
      });
      lines.push(
        `stiva_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${value.count}`,
        `stiva_http_request_duration_seconds_count{${labels}} ${value.count}`,
        `stiva_http_request_duration_seconds_sum{${labels}} ${value.seconds}`,
      );
    }
    for (const [name, value] of this.operations) {
      for (const key of ["active", "peak", "completed", "failed", "rejected"] as const) {
        const metric = `stiva_storage_${key}${["completed", "failed", "rejected"].includes(key) ? "_total" : ""}`;
        lines.push(`${metric}{operation=${label(name)}} ${value[key]}`);
      }
    }
    const memory = process.memoryUsage();
    lines.push(
      `# TYPE stiva_multipart_cleanup_failures_total counter`,
      `stiva_multipart_cleanup_failures_total ${this.cleanupFailures}`,
      `# TYPE stiva_process_resident_memory_bytes gauge`,
      `stiva_process_resident_memory_bytes ${memory.rss}`,
      "# TYPE stiva_process_heap_used_bytes gauge",
      `stiva_process_heap_used_bytes ${memory.heapUsed}`,
      "# TYPE stiva_process_uptime_seconds gauge",
      `stiva_process_uptime_seconds ${process.uptime()}`,
    );
    return `${lines.join("\n")}\n`;
  }
}
