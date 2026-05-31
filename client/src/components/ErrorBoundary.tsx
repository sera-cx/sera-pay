import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    console.error("[App] Runtime error recovered by auto-refresh", error);

    try {
      const key = "serapay_error_auto_reload";
      const now = Date.now();
      const saved = JSON.parse(sessionStorage.getItem(key) || "null") as { count: number; time: number } | null;
      const count = saved && now - saved.time < 30000 ? saved.count : 0;

      if (count < 2) {
        sessionStorage.setItem(key, JSON.stringify({ count: count + 1, time: now }));
        this.reloadTimer = setTimeout(() => window.location.reload(), 900);
      }
    } catch {
      this.reloadTimer = setTimeout(() => window.location.reload(), 900);
    }
  }

  componentWillUnmount() {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-background p-8">
          <div className="flex w-full max-w-sm flex-col items-center rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
            <div className="h-9 w-9 rounded-full border-2 border-[#00D1A0]/20 border-t-[#00D1A0] animate-spin" />
            <h2 className="mt-5 text-lg font-semibold text-foreground">Refreshing workspace</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              The app is restoring the session automatically.
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
