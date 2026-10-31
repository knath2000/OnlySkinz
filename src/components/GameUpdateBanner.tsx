import { AlertTriangle, Download, RefreshCw, X } from "lucide-react";

type Variant = "reapply" | "app-update";

interface GameUpdateBannerProps {
  variant: Variant;
  onAction: () => void;
  onDismiss: () => void;
}

const COPY: Record<Variant, { message: string; action: string }> = {
  reapply: {
    message: "League was updated. Re-apply your skins before playing.",
    action: "Re-apply",
  },
  "app-update": {
    message: "This League patch changed the game binary. OnlySkinz needs an update to work with it.",
    action: "Download update",
  },
};

export default function GameUpdateBanner({ variant, onAction, onDismiss }: GameUpdateBannerProps) {
  const { message, action } = COPY[variant];
  const severe = variant === "app-update";

  return (
    <div
      className={[
        "flex items-center gap-3 border-b px-4 py-2.5",
        severe ? "border-error/25 bg-error/10" : "border-gold-400/25 bg-gold-400/10",
      ].join(" ")}
    >
      <AlertTriangle
        size={16}
        className={["shrink-0", severe ? "text-error" : "text-gold-400"].join(" ")}
      />
      <span className="text-ink min-w-0 flex-1 truncate text-sm">{message}</span>
      <button
        onClick={onAction}
        className={[
          "flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-colors",
          severe
            ? "bg-error text-charcoal-600 hover:bg-error/80"
            : "bg-gold-400 text-charcoal-600 hover:bg-gold-300",
        ].join(" ")}
      >
        {severe ? (
          <Download size={13} strokeWidth={2.5} />
        ) : (
          <RefreshCw size={13} strokeWidth={2.5} />
        )}
        {action}
      </button>
      <button
        onClick={onDismiss}
        className="text-ink-muted hover:text-ink shrink-0 cursor-pointer transition-colors"
        title="Dismiss"
      >
        <X size={15} />
      </button>
    </div>
  );
}
