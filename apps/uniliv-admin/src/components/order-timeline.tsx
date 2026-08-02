import * as React from "react";
import { format } from "date-fns";
import { FileText, Check, Truck, PackageCheck, Ban, XCircle, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OrderStatus, FoodOrderEvent } from "@/lib/food-api";

/**
 * Horizontal order-journey stepper. Unlike a raw event log, this always renders
 * the full canonical path (Placed → Accepted → Dispatched → Received)
 * so an order shows where it IS and what's still ahead. Terminal states
 * (Cancelled / Rejected) replace the remaining path with a red end node.
 */
type Stage = { key: OrderStatus; label: string; icon: LucideIcon };

const HAPPY_PATH: Stage[] = [
  { key: "PLACED", label: "Placed", icon: FileText },
  { key: "ACCEPTED", label: "Accepted", icon: Check },
  { key: "DISPATCHED", label: "Dispatched", icon: Truck },
  { key: "DELIVERED", label: "Received", icon: PackageCheck },
];

const TERMINAL: Record<"CANCELLED" | "REJECTED", Stage> = {
  CANCELLED: { key: "CANCELLED", label: "Cancelled", icon: Ban },
  REJECTED: { key: "REJECTED", label: "Rejected", icon: XCircle },
};

const fmtWhen = (s?: string | null) => (s ? format(new Date(s), "dd MMM · HH:mm") : null);

type StepState = "done" | "current" | "upcoming" | "terminal";
type RenderStep = { stage: Stage; state: StepState; at: string | null; note?: string | null };

export function OrderTimeline({
  status,
  events,
  className,
}: {
  status: OrderStatus;
  events: FoodOrderEvent[];
  className?: string;
}) {
  // Earliest event per status = the moment the order entered that stage.
  const eventByStatus = React.useMemo(() => {
    const sorted = [...events].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const m = new Map<string, FoodOrderEvent>();
    for (const e of sorted) if (!m.has(e.status)) m.set(e.status, e);
    return m;
  }, [events]);

  const isTerminal = status === "CANCELLED" || status === "REJECTED";
  const happyIdxOfStatus = HAPPY_PATH.findIndex((s) => s.key === status);
  const reachedIdx = isTerminal
    ? HAPPY_PATH.reduce((max, s, i) => (eventByStatus.has(s.key) ? i : max), 0)
    : Math.max(0, happyIdxOfStatus);

  const steps: RenderStep[] = [];
  if (isTerminal) {
    for (let i = 0; i <= reachedIdx; i++) {
      const st = HAPPY_PATH[i]!;
      steps.push({ stage: st, state: "done", at: fmtWhen(eventByStatus.get(st.key)?.createdAt) });
    }
    const term = TERMINAL[status as "CANCELLED" | "REJECTED"];
    const te = eventByStatus.get(term.key);
    steps.push({ stage: term, state: "terminal", at: fmtWhen(te?.createdAt), note: te?.note });
  } else {
    HAPPY_PATH.forEach((st, i) => {
      const state: StepState = i < reachedIdx ? "done" : i === reachedIdx ? "current" : "upcoming";
      steps.push({ stage: st, state, at: fmtWhen(eventByStatus.get(st.key)?.createdAt) });
    });
  }

  return (
    <ol className={cn("flex w-full items-start overflow-x-auto pb-1", className)}>
      {steps.map((step, i) => {
        const Icon = step.stage.icon;
        const isLast = i === steps.length - 1;
        const reached = step.state !== "upcoming";
        return (
          <li
            key={step.stage.key}
            className="relative flex flex-1 shrink-0 basis-0 flex-col items-center px-1 text-center"
            style={{ minWidth: 86 }}
          >
            {/* connector to the next node — filled once this stage is fully complete */}
            {!isLast && (
              <span
                className={cn(
                  "absolute left-1/2 top-4 h-0.5 w-full -translate-y-1/2",
                  step.state === "done" ? "bg-accent" : "bg-border",
                )}
              />
            )}
            {/* soft pulse behind the current node */}
            {step.state === "current" && (
              <span className="pointer-events-none absolute left-1/2 top-0 h-8 w-8 -translate-x-1/2 rounded-full bg-accent/25 motion-safe:animate-ping" />
            )}
            <span
              className={cn(
                "relative z-10 flex h-8 w-8 items-center justify-center rounded-full ring-4 ring-card transition-colors",
                step.state === "done" && "bg-accent text-accent-foreground",
                step.state === "current" && "bg-accent text-accent-foreground ring-accent/30",
                step.state === "terminal" && "bg-destructive text-destructive-foreground",
                step.state === "upcoming" && "border-2 border-dashed border-border bg-card text-muted-foreground/70",
              )}
            >
              <Icon className="h-4 w-4" />
            </span>
            <p
              className={cn(
                "mt-2 text-sm font-medium leading-tight",
                reached ? "text-foreground" : "text-muted-foreground/70",
              )}
            >
              {step.stage.label}
            </p>
            <p
              className={cn(
                "mt-0.5 text-[11px] leading-tight",
                step.state === "terminal"
                  ? "text-destructive"
                  : step.state === "current"
                    ? "font-medium text-accent"
                    : "text-muted-foreground",
              )}
            >
              {step.at ?? (step.state === "upcoming" ? "Pending" : step.state === "current" ? "In progress" : "—")}
            </p>
            {step.note && <p className="mt-0.5 text-[11px] text-muted-foreground">{step.note}</p>}
          </li>
        );
      })}
    </ol>
  );
}
