import { memo } from "react";
import { Button } from "@base-ui/react/button";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { WebAgent } from "../../src/web/contracts";

// Transform only prose text. Code, existing links and email addresses keep their literal contents.
interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}
function remarkAgentMentions({ agents }: { agents: WebAgent[] }) {
  const members = new Map(agents.map((agent) => [agent.id, agent]));
  return (tree: MarkdownNode) => {
    function walk(node: MarkdownNode) {
      if (
        !node.children ||
        ["link", "linkReference", "code", "inlineCode"].includes(node.type)
      )
        return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) {
          walk(child);
          return [child];
        }
        const value = child.value;
        const parts: MarkdownNode[] = [];
        let offset = 0;
        for (const match of value.matchAll(/@([\w-]+)/g)) {
          const agent = members.get(match[1]!);
          if (
            !agent ||
            (match.index > 0 && /[\w@]/.test(value[match.index - 1]!))
          )
            continue;
          if (match.index > offset)
            parts.push({
              type: "text",
              value: value.slice(offset, match.index),
            });
          parts.push({
            type: "link",
            url: `#squad-agent/${encodeURIComponent(agent.id)}`,
            children: [{ type: "text", value: `@${agent.name}` }],
          });
          offset = match.index + match[0].length;
        }
        if (!parts.length) return [child];
        if (offset < value.length)
          parts.push({ type: "text", value: value.slice(offset) });
        return parts;
      });
    }
    walk(tree);
  };
}

export const MessageText = memo(
  function MessageText({
    text,
    agents,
    onAgent,
  }: {
    text: string;
    agents: WebAgent[];
    onAgent: (id: string) => void;
  }) {
    return (
      <div className="message-text">
        <Markdown
          remarkPlugins={[
            remarkGfm,
            remarkBreaks,
            [remarkAgentMentions, { agents }],
          ]}
          skipHtml
          components={{
            a({ node: _node, href, children, ...props }) {
              const agent = agents.find(
                (agent) =>
                  href === `#squad-agent/${encodeURIComponent(agent.id)}`,
              );
              if (agent)
                return (
                  <Button
                    className="inline-mention"
                    onClick={() => onAgent(agent.id)}
                  >
                    {children}
                  </Button>
                );
              if (!href) return <span>{children}</span>;
              return (
                <a
                  {...props}
                  href={href}
                  {...(href.startsWith("#")
                    ? {}
                    : { target: "_blank", rel: "noopener noreferrer" })}
                >
                  {children}
                </a>
              );
            },
            table({ children, ...props }) {
              const { node: _node, ...tableProps } = props;
              return (
                <div
                  className="markdown-table"
                  role="region"
                  aria-label="消息中的表格"
                  tabIndex={0}
                >
                  <table {...tableProps}>{children}</table>
                </div>
              );
            },
            img({ node: _node, ...props }) {
              return <img {...props} loading="lazy" />;
            },
          }}
        >
          {text}
        </Markdown>
      </div>
    );
  },
  (previous, next) =>
    previous.text === next.text &&
    previous.onAgent === next.onAgent &&
    previous.agents.length === next.agents.length &&
    previous.agents.every(
      (agent, index) =>
        agent.id === next.agents[index]?.id &&
        agent.name === next.agents[index]?.name,
    ),
);
