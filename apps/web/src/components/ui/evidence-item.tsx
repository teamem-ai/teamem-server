import { ExternalLink, GitPullRequest, GitCommit, FileCode, Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export type EvidenceKind = "pr" | "commit" | "repo_file" | "mcp_write";

const kindConfig: Record<
  EvidenceKind,
  { label: string; icon: typeof GitPullRequest }
> = {
  pr: { label: "Pull request", icon: GitPullRequest },
  commit: { label: "Commit", icon: GitCommit },
  repo_file: { label: "Repo file", icon: FileCode },
  mcp_write: { label: "MCP write", icon: Bot },
};

export function EvidenceItem({
  kind,
  ref: refText,
  time,
  timeLabel = "Occurred",
  permalink,
  href,
  children,
  className,
}: {
  kind: EvidenceKind;
  ref?: string;
  time?: string;
  timeLabel?: string;
  permalink?: boolean;
  href?: string;
  children?: ReactNode;
  className?: string;
}) {
  const config = kindConfig[kind];
  const Icon = config.icon;

  const content = (
    <div
      className={cn(
        "ev-item",
        href && "cursor-pointer",
        className
      )}
    >
      <div className="ev-ic">
        <Icon className="w-4 h-4" />
      </div>
      <div className="ev-main">
        <div className="ev-kind">
          {config.label}
          {permalink && (
            <span className="text-[11px] font-normal text-text-3">
              · permalink
            </span>
          )}
          {kind === "repo_file" && (
            <span className="text-[11px] font-normal text-text-3">
              · commit-pinned
            </span>
          )}
        </div>
        {refText && <div className="ev-ref">{refText}</div>}
        {time && (
          <div className="ev-time">
            {timeLabel} {time}
          </div>
        )}
        {children}
      </div>
      {href && (
        <div className="ev-ext">
          <ExternalLink className="w-3.5 h-3.5" />
        </div>
      )}
    </div>
  );

  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="no-underline hover:no-underline">
        {content}
      </a>
    );
  }
  return content;
}
