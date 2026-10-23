import type { Page } from "@playwright/test";
export async function reset(page: Page) {
  const result = await page.request.get("/api/servers");
  for (const server of await result.json()) await page.request.delete(`/api/servers/${server.id}`);
}

export async function mockStorage(page: Page) {
  await page.route("**/api/buckets", (route) =>
    route.fulfill({
      json: {
        buckets: [
          { name: "project-assets", created_at: "2026-10-01T12:00:00Z" },
          { name: "backups" },
        ],
      },
    }),
  );
  await page.route(/\/api\/buckets\/[^/]+\/objects\?/, (route) => {
    const prefix = new URL(route.request().url()).searchParams.get("prefix");
    return route.fulfill({
      json: prefix
        ? {
            objects: [
              {
                key: `${prefix}notes.txt`,
                size: 12,
                last_modified: "2026-10-20T10:00:00Z",
              },
            ],
            prefixes: [],
            next_token: null,
          }
        : {
            objects: [
              {
                key: "hello.txt",
                size: 12,
                last_modified: "2026-10-20T10:00:00Z",
              },
              {
                key: "photo.png",
                size: 2048,
                last_modified: "2026-10-21T11:00:00Z",
              },
            ],
            prefixes: ["documents/"],
            next_token: null,
          },
    });
  });
  await page.route("**/api/buckets/*/objects/metadata?*", (route) =>
    route.fulfill({
      json: {
        size: 12,
        content_type: "text/plain",
        metadata: { owner: "Stiva" },
        storage_class: "STANDARD",
      },
    }),
  );
  await page.route("**/api/stream/download?*", (route) =>
    route.fulfill({ contentType: "text/plain", body: "Hello Stiva!" }),
  );
  await page.route("**/api/presigned-url/download", (route) =>
    route.fulfill({
      json: {
        url: "http://127.0.0.1:4173/example-signed-download",
        expires_at: "2026-10-23T12:00:00Z",
        required_headers: {},
      },
    }),
  );
}
