import { useEffect, useState } from "react";
import { api, type Bucket, bucketPath, type Listing } from "../api";

export function useBuckets(serverId: string, serverRevision: string, refresh: number) {
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: configuration edits and refresh invalidate this read.
  useEffect(() => {
    const controller = new AbortController();
    setBuckets([]);
    setConnected(null);
    setError("");
    if (!serverId) {
      setBusy(false);
      return;
    }
    setBusy(true);
    api<{ buckets: Bucket[] }>("/api/buckets", { signal: controller.signal }, serverId)
      .then((result) => {
        if (!controller.signal.aborted) {
          setBuckets(result.buckets);
          setConnected(true);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err.message);
          setConnected(false);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [serverId, serverRevision, refresh]);
  return { buckets, busy, connected, error };
}

const empty: Listing = { objects: [], prefixes: [], next_token: null };
export function useObjects(
  serverId: string,
  bucket: string,
  prefix: string,
  token: string | undefined,
  refresh: number,
) {
  const [listing, setListing] = useState<Listing>(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly reloads the same page.
  useEffect(() => {
    setError("");
    if (!serverId || !bucket) {
      setListing(empty);
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    setBusy(true);
    const query = new URLSearchParams({ prefix });
    if (token) query.set("continuationToken", token);
    api<Listing>(`${bucketPath(bucket)}/objects?${query}`, { signal: controller.signal }, serverId)
      .then((result) => {
        if (!controller.signal.aborted) setListing(result);
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err.message);
          setListing(empty);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [serverId, bucket, prefix, token, refresh]);
  return { listing, busy, error };
}
