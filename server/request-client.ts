import { AbortMultipartUploadCommand, type S3Client } from "@aws-sdk/client-s3";

/** A request view keeps disconnect cancellation local without modifying the SDK client. */
export function requestClient(client: S3Client, signal: AbortSignal): S3Client {
  const send = client.send.bind(client);
  const scopedSend = ((
    command: Parameters<S3Client["send"]>[0],
    settings?: { abortSignal?: AbortSignal },
  ) =>
    send(command, {
      ...settings,
      // Cleanup must remain usable after the caller disconnects.
      abortSignal:
        command instanceof AbortMultipartUploadCommand
          ? settings?.abortSignal
          : settings?.abortSignal
            ? AbortSignal.any([signal, settings.abortSignal])
            : signal,
    })) as S3Client["send"];
  return new Proxy(client, {
    get(target, property) {
      if (property === "send") return scopedSend;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
