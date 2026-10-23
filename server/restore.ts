import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  type S3Client,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3";
import { HttpError } from "./errors.js";

/** Copy an immutable version into a new current version, without downloading its contents. */
export async function restoreVersion(
  client: S3Client,
  bucket: string,
  key: string,
  versionId: string,
  signal: AbortSignal,
) {
  const metadata = await client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
    { abortSignal: signal },
  );
  if (metadata.DeleteMarker)
    throw new HttpError(409, "Delete markers cannot be restored as file contents");
  const source = `${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}?versionId=${encodeURIComponent(versionId)}`;
  const size = metadata.ContentLength ?? 0;
  if (size <= 5 * 1024 ** 3) {
    return client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: key,
        CopySource: source,
        CopySourceIfMatch: metadata.ETag,
        MetadataDirective: "COPY",
        TaggingDirective: "COPY",
      }),
      { abortSignal: signal },
    );
  }
  const partSize = Math.max(64 * 1024 ** 2, Math.ceil(size / 10000 / 1024 ** 2) * 1024 ** 2);
  if (partSize > 5 * 1024 ** 3) throw new HttpError(413, "Object exceeds S3 multipart copy limits");
  const tags = await client.send(
    new GetObjectTaggingCommand({
      Bucket: bucket,
      Key: key,
      VersionId: versionId,
    }),
    { abortSignal: signal },
  );
  const created = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ContentType: metadata.ContentType,
      Metadata: metadata.Metadata,
      CacheControl: metadata.CacheControl,
      ContentDisposition: metadata.ContentDisposition,
      ContentEncoding: metadata.ContentEncoding,
      ContentLanguage: metadata.ContentLanguage,
      Expires: metadata.Expires,
      WebsiteRedirectLocation: metadata.WebsiteRedirectLocation,
      ServerSideEncryption: metadata.ServerSideEncryption,
      SSEKMSKeyId: metadata.SSEKMSKeyId,
      BucketKeyEnabled: metadata.BucketKeyEnabled,
      Tagging: tags.TagSet?.length
        ? new URLSearchParams(tags.TagSet.map((tag) => [tag.Key!, tag.Value!])).toString()
        : undefined,
    }),
    { abortSignal: signal },
  );
  if (!created.UploadId)
    throw new HttpError(502, "Storage did not return a multipart upload identifier");
  const uploadId = created.UploadId;
  try {
    const parts: { ETag: string; PartNumber: number }[] = [];
    const count = Math.ceil(size / partSize);
    for (let index = 0; index < count; index += 2) {
      const results = await Promise.allSettled(
        Array.from({ length: Math.min(2, count - index) }, async (_, offset) => {
          const partIndex = index + offset;
          const result = await client.send(
            new UploadPartCopyCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
              PartNumber: partIndex + 1,
              CopySource: source,
              CopySourceIfMatch: metadata.ETag,
              CopySourceRange: `bytes=${partIndex * partSize}-${Math.min(size - 1, (partIndex + 1) * partSize - 1)}`,
            }),
            { abortSignal: signal },
          );
          if (!result.CopyPartResult?.ETag)
            throw new HttpError(502, "Storage did not return a copied-part checksum");
          return {
            ETag: result.CopyPartResult.ETag,
            PartNumber: partIndex + 1,
          };
        }),
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      for (const result of results) if (result.status === "fulfilled") parts.push(result.value);
    }
    return await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
      { abortSignal: signal },
    );
  } catch (error) {
    try {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
        }),
        { abortSignal: AbortSignal.timeout(15000) },
      );
    } catch {
      throw new HttpError(
        502,
        "Restore failed and multipart cleanup could not be confirmed. Inspect incomplete multipart uploads on the S3 server.",
      );
    }
    throw error;
  }
}
