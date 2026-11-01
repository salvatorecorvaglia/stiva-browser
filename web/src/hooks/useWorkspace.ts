import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import type { WorkspaceModal } from "../types";

/** Own location, pagination, selection and modal invalidation as one workspace. */
export function useWorkspace(
  serverId: string,
  serverContext: string,
  setServerId: Dispatch<SetStateAction<string>>,
) {
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("");
  const [tokens, setTokens] = useState<(string | undefined)[]>([undefined]);
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [sidebar, setSidebar] = useState(false);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<WorkspaceModal>(null);
  const contextVersion = useRef(0);
  const pendingBucket = useRef<string | null>(null);
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 680px)").matches);
  const sidebarToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 680px)");
    const update = () => setMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: configuration identity invalidates the workspace.
  useEffect(() => {
    contextVersion.current++;
    setBucket(pendingBucket.current ?? "");
    pendingBucket.current = null;
    setPrefix("");
    setTokens([undefined]);
    setPage(0);
    setModal(null);
  }, [serverContext]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: page changes and refresh clear the previous selection.
  useEffect(() => {
    setSelected(new Set());
  }, [serverId, bucket, prefix, page, revision]);

  function navigate(nextBucket: string, nextPrefix = "") {
    contextVersion.current++;
    setBucket(nextBucket);
    setPrefix(nextPrefix);
    setPage(0);
    setTokens([undefined]);
    setFilter("");
    setSelected(new Set());
    setSidebar(false);
    if (mobile) sidebarToggle.current?.focus();
    setModal(null);
  }
  function switchServer(id: string) {
    contextVersion.current++;
    setServerId(id);
    navigate("");
  }
  function closeModal() {
    contextVersion.current++;
    setModal(null);
  }
  function refresh() {
    setPage(0);
    setTokens([undefined]);
    setRevision((value) => value + 1);
  }
  return {
    bucket,
    prefix,
    tokens,
    setTokens,
    page,
    setPage,
    revision,
    sidebar,
    setSidebar,
    filter,
    setFilter,
    selected,
    setSelected,
    modal,
    setModal,
    contextVersion,
    pendingBucket,
    mobile,
    sidebarToggle,
    navigate,
    switchServer,
    closeModal,
    refresh,
  };
}
