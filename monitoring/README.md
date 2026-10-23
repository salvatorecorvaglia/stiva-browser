# Monitoring

Scrape `/api/metrics` every 15 seconds through a restricted internal network or your existing
authentication proxy. The endpoint shares API throttling and returns `Cache-Control: no-store`.
A deployment with many scrapers must account for that traffic in `API_RATE_LIMIT`.

Example Prometheus configuration (adjust the service name and rule path):

```yaml
global:
  scrape_interval: 15s
rule_files:
  - /etc/prometheus/stiva/alerts.yml
scrape_configs:
  - job_name: stiva
    metrics_path: /api/metrics
    static_configs:
      - targets: ["stiva-browser:3000"]
```

If scraping the authenticated public ingress instead, use HTTPS, configure the appropriate CA and
`authorization.credentials_file`, and point to that ingress. Do not expose an unauthenticated API
just to enable metrics. Connect these rules to your existing Alertmanager and notification routes.
No production receiver or credentials are included in this repository.

`alerts.yml` covers target availability, multipart cleanup failures, sustained admission rejection,
read latency and memory headroom for the default 512 MiB container. Adjust the memory threshold
when changing the container limit. Process RSS excludes other cgroup charges; also monitor the
container's actual memory usage and OOM events in your platform monitoring.

`pnpm test:staging` runs `promtool test rules alerts.test.yml` using a pinned Prometheus image,
then scrapes a real application and checks that an injected multipart cleanup failure produces a
firing alert. The integration test proves rule evaluation; delivery through a production receiver
requires validation in that deployment.

For cleanup alerts, inspect incomplete multipart uploads on the affected S3 server with your
provider's tools. Confirm no active writer owns them before aborting them. Configure an appropriate
bucket lifecycle rule to expire incomplete multipart uploads as a second line of recovery. The
application deliberately avoids putting object keys, endpoints or credentials in metric labels.
