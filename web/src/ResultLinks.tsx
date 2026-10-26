import { Button } from "@base-ui/react/button";
import { ChevronRight, FileText } from "lucide-react";
import type { Message } from "../../src/types";
import type { RoomSnapshot } from "../../src/web/contracts";
import { compactMessage } from "../../src/presentation";

export interface DetailTarget {
  taskId: string;
  messageId?: string;
  artifactId?: string;
}

export function messageArtifacts(snapshot: RoomSnapshot | null, message: Message) {
  const task = snapshot?.tasks.find((item) => item.id === message.taskId);
  const ids = new Set(message.artifactIds ?? []);
  return task?.artifacts.filter((artifact) => ids.has(artifact.id)) ?? [];
}

export function artifactsForAgent(snapshot: RoomSnapshot | null, agentId: string) {
  return snapshot?.tasks.flatMap((task) => task.artifacts
    .filter((artifact) => artifact.author ? artifact.author === agentId : task.owner === agentId)
    .map((artifact) => ({ ...artifact, taskId: task.id }))) ?? [];
}

export function hasMessageDetails(snapshot: RoomSnapshot | null, message: Message) {
  const task = snapshot?.tasks.find((item) => item.id === message.taskId);
  return !!task && !!(message.detailText || compactMessage(message.text) !== message.text || messageArtifacts(snapshot, message).length
    || task.board.length || task.trace.length
    || snapshot?.works.some((work) => work.taskId === task.id && work.agentId === message.author)
    || snapshot?.events.some((event) => event.taskId === task.id && event.agentId === message.author));
}

export function ResultLinks({ snapshot, message, onOpen }: {
  snapshot: RoomSnapshot | null;
  message: Message;
  onOpen: (target: DetailTarget) => void;
}) {
  if (message.kind === "user") return null;
  const artifacts = messageArtifacts(snapshot, message);
  const details = hasMessageDetails(snapshot, message);
  if (!artifacts.length && !details) return null;
  const target = { taskId: message.taskId, messageId: message.id };
  return (
    <div className="result-links">
      {artifacts.map((artifact) => (
        <Button className="result-link" key={artifact.id} aria-label={`查看 ${artifact.name}`}
          onClick={() => onOpen({ ...target, artifactId: artifact.id })}>
          <FileText size={13} aria-hidden="true" /> {artifact.name}
        </Button>
      ))}
      {details && <Button className="result-link result-detail-link" aria-label="查看消息详情" onClick={() => onOpen(target)}>
        详情 <ChevronRight size={12} aria-hidden="true" />
      </Button>}
    </div>
  );
}
