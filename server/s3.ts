import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import type { ServerInput } from "./store.js";

export function makeS3(
  input: Pick<ServerInput, "endpoint_url" | "region" | "force_path_style">,
  credentials: { accessKeyId: string; secretAccessKey: string },
) {
  const options: S3ClientConfig = {
    endpoint: input.endpoint_url,
    region: input.region,
    forcePathStyle: input.force_path_style,
    credentials,
    maxAttempts: 2,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: {
      connectionTimeout: 5000,
      requestTimeout: 120000,
      throwOnRequestTimeout: true,
      socketTimeout: 60000,
    },
  };
  return new S3Client(options);
}
