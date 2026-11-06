import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import { deleteKeys } from "../server/deletion.js";
import { makeS3 } from "../server/s3.js";

test("bulk deletion signs an MD5 of the serialized body and requests acknowledgments", async () => {
  const client = makeS3(
    { endpoint_url: "http://storage.invalid", region: "us-east-1", force_path_style: true },
    { accessKeyId: "fixture", secretAccessKey: "fixture-secret" },
  );
  let sent = 0;
  client.config.requestHandler = {
    async handle(request) {
      sent++;
      const body = String(request.body);
      assert.equal(request.headers["content-md5"], createHash("md5").update(body).digest("base64"));
      assert.match(request.headers.authorization, /content-md5/);
      assert.match(body, /<Quiet>false<\/Quiet>/);
      assert.match(body, /a&amp;b/);
      return {
        response: {
          statusCode: 200,
          headers: { "content-type": "application/xml" },
          body: Readable.from([
            '<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Deleted><Key>folder/</Key></Deleted><Deleted><Key>folder/a&amp;b</Key></Deleted></DeleteResult>',
          ]),
        },
      };
    },
  };
  try {
    assert.deepEqual(await deleteKeys(client, "fixture", ["folder/", "folder/a&b"]), {
      deleted: ["folder/", "folder/a&b"],
      errors: [],
    });
    assert.equal(sent, 1);
  } finally {
    client.destroy();
  }
});

test("storage rejections preserve the service error code", async () => {
  const client = new S3Client({
    region: "us-east-1",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture-secret" },
    requestHandler: {
      async handle() {
        return {
          response: {
            statusCode: 403,
            headers: { "content-type": "application/xml" },
            body: Readable.from([
              "<Error><Code>AccessDenied</Code><Message>Denied</Message></Error>",
            ]),
          },
        };
      },
    },
  });
  try {
    assert.deepEqual(await deleteKeys(client, "fixture", ["test/"]), {
      deleted: [],
      errors: [{ key: "test/", code: "AccessDenied" }],
    });
  } finally {
    client.destroy();
  }
});
