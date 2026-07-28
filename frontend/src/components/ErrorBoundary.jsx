import { Component } from 'react';

// A render error inside a report used to blank the whole content area with no
// explanation — the worst failure mode for something a barangay official
// depends on. This catches it and shows what went wrong instead.
//
// Pass `resetKey`; when it changes (e.g. a different report or date range is
// selected) the boundary clears its error and tries rendering again, so one
// bad report doesn't wedge the screen until a page reload.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  // Clear the error when the caller switches subject (a different report or
  // date range), so one bad render doesn't wedge the screen until a reload.
  // Done here rather than in componentDidUpdate to avoid a second render pass.
  static getDerivedStateFromProps(props, state) {
    if (props.resetKey === state.resetKey) return null;
    return { error: null, resetKey: props.resetKey };
  }

  componentDidCatch(error, info) {
    // Keep the stack in the console for debugging; the UI stays readable.
    console.error('Render failed:', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="alert error">
        <strong>{this.props.title || 'This section could not be displayed.'}</strong>
        <div className="reason-note">
          {error.message || String(error)}
        </div>
        <div className="reason-note muted">
          The data may be in an unexpected format. Try a different date range, or report this to
          the system administrator.
        </div>
      </div>
    );
  }
}
