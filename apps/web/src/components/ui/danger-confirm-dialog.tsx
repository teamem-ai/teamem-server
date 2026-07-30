import { useState } from "react";
import { AlertTriangle } from "lucide-react";

export type DangerLevel = "normal" | "type-name";

export function DangerConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  confirmTarget, // user must type this to unlock the button (type-name level only)
  onConfirm,
  level = "normal",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  confirmTarget?: string;
  onConfirm: () => void;
  level?: DangerLevel;
}) {
  const [typed, setTyped] = useState("");

  if (!open) return null;

  const canConfirm =
    level === "normal" || (confirmTarget && typed === confirmTarget);

  return (
    <div className="modal-veil" onClick={() => onOpenChange(false)}>
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <AlertTriangle className="w-5 h-5 text-red flex-none mt-0.5" />
          <div>
            <h3>{title}</h3>
            <p className="m-sub">{description}</p>
          </div>
          <button
            className="modal-x"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {level === "type-name" && confirmTarget && (
          <div className="modal-body space-y-3">
            <p className="text-[13px] text-text-2">
              Type <code className="font-semibold">{confirmTarget}</code> to
              confirm:
            </p>
            <input
              className="input mono"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={confirmTarget}
              autoFocus
            />
          </div>
        )}

        <div className="modal-foot">
          <button
            className="btn btn-ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </button>
          <button
            className={
              level === "type-name"
                ? "btn btn-danger"
                : "btn btn-danger-outline"
            }
            disabled={!canConfirm}
            onClick={() => {
              if (canConfirm) {
                onConfirm();
                onOpenChange(false);
              }
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
