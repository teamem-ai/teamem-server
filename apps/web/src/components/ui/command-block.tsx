import { Copy, Check } from "lucide-react";
import { useState, useCallback } from "react";
import { cn } from "@/lib/utils";

/** One-time key reveal block: dark background, amber monospace token,
 *  "won't see again" warning. (Red line R7) */
export function KeyReveal({
  token,
  className,
}: {
  token: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [token]);

  return (
    <div className={cn("space-y-3", className)}>
      <div className="key-reveal">
        <code>{token}</code>
        <button onClick={handleCopy} className="copy-btn">
          {copied ? (
            <Check className="w-3 h-3" />
          ) : (
            <Copy className="w-3 h-3" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="text-[12.5px] text-red" role="alert">
        Copy it now — you won&apos;t see this key again. We store only a hash.
      </p>
    </div>
  );
}

/** Copyable command block: dark background, copy button, optional description. */
export function CommandBlock({
  command,
  description,
  className,
}: {
  command: string;
  description?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [command]);

  return (
    <div className={cn("space-y-2", className)}>
      {description && (
        <p className="text-[13px] text-text-2">{description}</p>
      )}
      <div className="cmd-block">
        <code>{command}</code>
        <button onClick={handleCopy} className="copy-btn">
          {copied ? (
            <Check className="w-3 h-3" />
          ) : (
            <Copy className="w-3 h-3" />
          )}
          {copied ? "Copied" : "Copy command"}
        </button>
      </div>
    </div>
  );
}
