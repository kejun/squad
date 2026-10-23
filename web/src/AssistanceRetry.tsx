import { Button } from "@base-ui/react/button";
import { RotateCcw } from "lucide-react";
import type { Submission } from "../../src/engine";
import type { WebAssistance } from "../../src/web/contracts";

export function assistanceRetrySubmission(help: WebAssistance, id: string): Submission {
  return {
    id,
    text: `重试 ${help.target} 的这次协助`,
    intent: "retry",
    replyToTaskId: help.taskId,
    retryAssistanceId: help.id,
  };
}

export function AssistanceRetry({ help, connected, sending, onRetry }: {
  help: WebAssistance;
  connected: boolean;
  sending: boolean;
  onRetry: (help: WebAssistance) => void;
}) {
  const reason = !connected ? "连接恢复后可重试" : help.reason;
  return (
    <div className="assistance-retry">
      <Button
        className="retry-assistance-button"
        disabled={!connected || sending || !help.retryable}
        onClick={() => onRetry(help)}
        title={reason || "重新核查后交回原负责人"}
      >
        <RotateCcw size={12} />重试 {help.target} 的这次协助
      </Button>
      {reason && <span>{reason}</span>}
    </div>
  );
}
