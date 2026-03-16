import React, { Component, ReactNode } from "react";
import {
  Button,
  Text,
  Title3,
  Body1,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import {
  ErrorCircle24Filled,
  ArrowClockwise24Regular,
} from "@fluentui/react-icons";

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "40vh",
    gap: tokens.spacingVerticalL,
    padding: tokens.spacingHorizontalXL,
    textAlign: "center",
  },
  icon: {
    color: tokens.colorPaletteRedForeground1,
    width: "48px",
    height: "48px",
  },
  message: {
    color: tokens.colorNeutralForeground2,
    maxWidth: "480px",
  },
  actions: {
    display: "flex",
    gap: tokens.spacingHorizontalM,
  },
});

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
  const styles = useStyles();
  return (
    <div className={styles.container}>
      <ErrorCircle24Filled className={styles.icon} />
      <Title3>
        {pageName ? `Failed to load ${pageName}` : "Something went wrong"}
      </Title3>
      <Body1 className={styles.message}>
        {error?.message || "An unexpected error occurred. Please try again."}
      </Body1>
      <div className={styles.actions}>
        <Button
          appearance="primary"
          icon={<ArrowClockwise24Regular />}
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
      </div>
    </div>
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
