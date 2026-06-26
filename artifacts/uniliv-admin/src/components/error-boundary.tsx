import * as React from "react";
import { AlertTriangle, RotateCcw, Home } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /**
   * When this value changes (e.g. the current route), the boundary resets and
   * re-renders its children. Lets a user navigate away from a crashed page via
   * the sidebar instead of being stuck on the fallback.
   */
  resetKey?: unknown;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * App-level error boundary. Catches render/lifecycle errors anywhere in the
 * routed tree and shows a branded fallback ("Something went wrong" + Reload +
 * Go to home) instead of a blank white screen. Logs the error to the console
 * for diagnostics. Dependency-light: a plain React class component (boundaries
 * cannot be hooks) plus the shared Button.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Surface the crash for diagnostics. No external logging dependency.
    console.error("[ErrorBoundary] Uncaught error:", error, info.componentStack);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    // Reset on route (or other reset key) change so navigating away from a
    // crashed page recovers without a full reload.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="flex min-h-[60vh] w-full items-center justify-center p-6">
          <div className="flex max-w-md flex-col items-center text-center">
            <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-destructive/12">
              <AlertTriangle className="h-7 w-7 text-destructive" />
            </div>
            <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">
              Something went wrong
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              An unexpected error occurred while rendering this page. You can
              reload to try again, or head back to the dashboard.
            </p>
            {this.state.error?.message && (
              <p className="mt-3 max-w-full truncate rounded-md bg-muted px-3 py-1.5 font-mono text-xs text-muted-foreground">
                {this.state.error.message}
              </p>
            )}
            <div className="mt-6 flex items-center gap-3">
              <Button onClick={this.handleReload} className="bg-accent hover:bg-accent/90 text-white">
                <RotateCcw className="mr-2 h-4 w-4" /> Reload page
              </Button>
              <Button variant="outline" asChild>
                <a href={import.meta.env.BASE_URL || "/"}>
                  <Home className="mr-2 h-4 w-4" /> Go to home
                </a>
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
