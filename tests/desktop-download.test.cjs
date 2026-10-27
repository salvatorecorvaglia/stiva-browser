const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const { mkdtemp, readdir, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");
const vm = require("node:vm");

test("macOS rejects corrupt, oversized, incomplete and HTTP-error downloads before unpacking", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stiva-download-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [body, size, status, expected] of [
    ["corrupt", 7, 200, /checksum/],
    ["too long", 2, 200, /larger/],
    ["short", 100, 200, /ended early/],
    ["error", 5, 500, /HTTP 500/],
  ]) {
    let unpacked = false;
    const module = { exports: {} };
    vm.runInNewContext(
      readFileSync(path.join(__dirname, "../desktop/mac-self-update.cjs"), "utf8"),
      {
        module,
        process,
        console,
        URL,
        Buffer,
        require(name) {
          if (name === "node:os") return { ...os, tmpdir: () => directory };
          if (name === "node:child_process")
            return {
              execFile() {
                unpacked = true;
                throw new Error("Must not unpack an unverified download");
              },
            };
          if (name === "electron")
            return {
              net: {
                request({ url }) {
                  assert.match(
                    url,
                    /^https:\/\/github.com\/salvatorecorvaglia\/stiva-browser\/releases\/download\/v1.3.0\//,
                  );
                  const request = new EventEmitter();
                  request.abort = () => {};
                  request.end = () => {
                    const response = Readable.from([Buffer.from(body)]);
                    response.statusCode = status;
                    request.emit("response", response);
                  };
                  return request;
                },
              },
            };
          return require(name);
        },
      },
    );
    await assert.rejects(
      module.exports.stageUpdate(
        {
          version: "1.3.0",
          files: [
            {
              url: `stiva-browser_1.3.0_mac_${process.arch}.zip`,
              size,
              sha512: createHash("sha512").update("trusted installer").digest("base64"),
            },
          ],
        },
        () => {},
      ),
      expected,
    );
    assert.equal(unpacked, false);
    assert.deepEqual(await readdir(directory), []);
  }
});
