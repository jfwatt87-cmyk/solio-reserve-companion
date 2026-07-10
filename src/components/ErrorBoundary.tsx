import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Catches any render-time error in the tree and shows a friendly, branded
 * fallback instead of a blank white screen. A single component fault should
 * never take the whole app down silently.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) console.error("App error:", error, info.componentStack);
    else console.error("App error");
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-screen">
          <div className="error-card">
            <span className="brand-mark big">◆</span>
            <h2>Something went wrong</h2>
            <p>The app hit an unexpected problem. Reloading usually fixes it.</p>
            <button className="btn btn-accent block" onClick={() => location.reload()}>Reload</button>
            {import.meta.env.DEV && (
              <pre className="error-detail">{String(this.state.error?.message ?? this.state.error)}</pre>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
