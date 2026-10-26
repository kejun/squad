import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDownToLine, Copy, LoaderCircle, X } from "lucide-react";
import { IconButton } from "./ui";
import { safeDownloadName, type DetailDocument } from "./detail-document";

/** Only a user gesture invokes this browser-local transfer. */
export function downloadDetailDocument(value: DetailDocument): void {
  const revoke = URL.revokeObjectURL.bind(URL);
  let url: string | undefined;
  let anchor: HTMLAnchorElement | undefined;
  try {
    url = URL.createObjectURL(new Blob([value.content], { type: value.mimeType }));
    anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = safeDownloadName(value.name);
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor?.remove();
    if (url) {
      const objectURL = url;
      // Let the browser consume the download before releasing its backing data.
      setTimeout(() => revoke(objectURL), 1000);
    }
  }
}

function sameDocument(left: DetailDocument | null, right: DetailDocument | null) {
  return left === right || !!left && !!right && left.id === right.id
    && left.name === right.name && left.content === right.content
    && left.mimeType === right.mimeType;
}

interface View { document: DetailDocument | null }
interface Request { view: View }
interface Feedback { view: View; kind: "success" | "error"; text: string }

export function DetailActions({ document: value, onClose, children }: {
  document: DetailDocument | null;
  onClose: () => void;
  children: ReactNode;
}) {
  const mounted = useRef(false);
  const current = useRef<View>({ document: value });
  // Object-only snapshot polling preserves feedback. A changed document gets a
  // fresh identity, including when the user later returns to an earlier view.
  if (!sameDocument(current.current.document, value)) current.current = { document: value };
  const view = current.current;
  const pending = useRef<Request | null>(null);
  const [copying, setCopying] = useState<Request | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const visibleFeedback = feedback?.view === view ? feedback : null;
  const busy = copying?.view === view;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current = null; };
  }, []);
  useEffect(() => {
    if (!feedback || feedback.kind === "error") return;
    const timeout = setTimeout(() => {
      setFeedback((previous) => previous === feedback ? null : previous);
    }, 2500);
    return () => clearTimeout(timeout);
  }, [feedback]);

  const copy = async () => {
    const captured = view.document;
    if (!captured || pending.current?.view === view) return;
    const request = { view };
    pending.current = request;
    setCopying(request);
    setFeedback(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(captured.content);
      if (mounted.current && current.current === view && pending.current === request) {
        setFeedback({ view, kind: "success", text: "已复制" });
      }
    } catch {
      if (mounted.current && current.current === view && pending.current === request) {
        setFeedback({ view, kind: "error", text: "复制失败，请重试或导出" });
      }
    } finally {
      if (pending.current === request) pending.current = null;
      if (mounted.current) setCopying((previous) => previous === request ? null : previous);
    }
  };
  const exportFile = () => {
    if (!view.document) return;
    try {
      downloadDetailDocument(view.document);
      setFeedback({ view, kind: "success", text: "已开始导出" });
    } catch {
      setFeedback({ view, kind: "error", text: "导出失败，请重试" });
    }
  };

  return <>
    <header className="details-header">
      {children}
      <div className="detail-header-actions">
        <IconButton label="复制详情" disabled={!value || busy} onClick={() => { void copy(); }}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <Copy size={16} />}
        </IconButton>
        <IconButton label="导出详情" disabled={!value} onClick={exportFile}>
          <ArrowDownToLine size={16} />
        </IconButton>
        <IconButton label="关闭详情" onClick={onClose}><X size={17} /></IconButton>
      </div>
    </header>
    {visibleFeedback && <div className={`detail-action-feedback${visibleFeedback.kind === "error" ? " is-error" : ""}`}
      role={visibleFeedback.kind === "error" ? "alert" : "status"} aria-live={visibleFeedback.kind === "error" ? "assertive" : "polite"}>
      {visibleFeedback.text}
    </div>}
  </>;
}
