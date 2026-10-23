import assert from "node:assert/strict";
import type {
  AbortMultipartUploadCommandInput,
  CompleteMultipartUploadCommandInput,
  CopyObjectCommandInput,
  CreateMultipartUploadCommandInput,
  DeleteObjectCommandInput,
  DeleteObjectsCommandInput,
  GetObjectCommandInput,
  GetObjectTaggingCommandInput,
  HeadObjectCommandInput,
  ListBucketsCommandInput,
  ListObjectsV2CommandInput,
  ListObjectVersionsCommandInput,
  PutObjectCommandInput,
  S3Client,
  UploadPartCommandInput,
  UploadPartCopyCommandInput,
} from "@aws-sdk/client-s3";

export function required<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null, "Expected a fixture value to exist");
  return value;
}
interface Inputs {
  AbortMultipartUploadCommand: AbortMultipartUploadCommandInput;
  CompleteMultipartUploadCommand: CompleteMultipartUploadCommandInput;
  CopyObjectCommand: CopyObjectCommandInput;
  CreateMultipartUploadCommand: CreateMultipartUploadCommandInput;
  DeleteObjectCommand: DeleteObjectCommandInput;
  DeleteObjectsCommand: DeleteObjectsCommandInput;
  GetObjectCommand: GetObjectCommandInput;
  GetObjectTaggingCommand: GetObjectTaggingCommandInput;
  HeadObjectCommand: HeadObjectCommandInput;
  ListBucketsCommand: ListBucketsCommandInput;
  ListObjectsV2Command: ListObjectsV2CommandInput;
  ListObjectVersionsCommand: ListObjectVersionsCommandInput;
  PutObjectCommand: PutObjectCommandInput;
  UploadPartCommand: UploadPartCommandInput;
  UploadPartCopyCommand: UploadPartCopyCommandInput;
}
export type S3Call = { [Name in keyof Inputs]: { name: Name; input: Inputs[Name] } }[keyof Inputs];
export type S3Handler = (call: S3Call, signal?: AbortSignal) => unknown | Promise<unknown>;

/** The only SDK overload cast: fixtures retain each command's typed, discriminated input. */
export function mockSend(client: S3Client, handler: S3Handler) {
  client.send = ((
    command: { constructor: { name: string }; input: unknown },
    options?: { abortSignal?: AbortSignal },
  ) => {
    const call = { name: command.constructor.name, input: command.input } as S3Call;
    return Promise.resolve().then(() => handler(call, options?.abortSignal));
  }) as unknown as S3Client["send"];
}
