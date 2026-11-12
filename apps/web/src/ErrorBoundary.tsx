import { Component, type ErrorInfo, type ReactNode } from 'react';

type State = { failed: boolean };

/** Root boundary: logs only the error's name and message, never props or state. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    console.error(`${error.name}: ${error.message}`);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="error-boundary card">
        <p>Something went wrong.</p>
        <button type="button" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
