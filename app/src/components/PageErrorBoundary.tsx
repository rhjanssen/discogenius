import { Component, ReactNode } from "react";
import {
  Button,
} from "@fluentui/react-components";
import {
  ArrowClockwise24Regular,
  ArrowClockwise24Filled,
  bundleIcon
} from "@fluentui/react-icons";
import { ErrorState } from "@/components/ui/ContentState";

const ArrowClockwise24 = bundleIcon(ArrowClockwise24Filled, ArrowClockwise24Regular);

interface Props {
  children: ReactNode;
  pageName?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

const ErrorFallback = ({
  error,
  pageName,
  onReset,
}: {
  error: Error | null;
  pageName?: string;
  onReset: () => void;
}) => {
  return (
    <ErrorState
      title={pageName ? `Failed to load ${pageName}` : "Something went wrong"}
      error={error}
      minHeight="320px"
      actions={
        <>
        <Button
          appearance="primary"
          icon={<ArrowClockwise24 />}
          onClick={onReset}
        >
          Try Again
        </Button>
        <Button
          appearance="secondary"
          onClick={() => window.location.reload()}
        >
          Refresh Page
        </Button>
        </>
      }
    />
  );
};

class PageErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    console.error(`[PageErrorBoundary:${this.props.pageName || "unknown"}]`, error);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <ErrorFallback
          error={this.state.error}
          pageName={this.props.pageName}
          onReset={this.handleReset}
        />
      );
    }
    return this.props.children;
  }
}

export default PageErrorBoundary;
