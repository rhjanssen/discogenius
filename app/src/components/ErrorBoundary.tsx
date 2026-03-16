import React, { Component, ErrorInfo, ReactNode } from "react";
import {
  Button,
  Card,
  Title1,
  Body1,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ErrorCircle24Filled, ArrowClockwise24Regular } from "@fluentui/react-icons";

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    padding: tokens.spacingHorizontalXXL,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  card: {
    maxWidth: "500px",
    width: "100%",
    textAlign: "center",
    padding: tokens.spacingHorizontalXXL,
  },
  icon: {
    color: tokens.colorPaletteRedForeground1,
    width: "48px",
    height: "48px",
    marginBottom: tokens.spacingVerticalL,
  },
  title: {
    marginBottom: tokens.spacingVerticalM,
  },
  message: {
    color: tokens.colorNeutralForeground2,
    marginBottom: tokens.spacingVerticalL,
  },
  details: {
    textAlign: "left",
    backgroundColor: tokens.colorNeutralBackground3,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    marginBottom: tokens.spacingVerticalL,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    maxHeight: "200px",
    overflow: "auto",
  },
  actions: {
    display: "flex",
    gap: tokens.spacingHorizontalM,
    justifyContent: "center",
  },
});

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

// Functional component for styled error display
const ErrorDisplay = ({
  error,
  errorInfo,
  onReset,
}: {
  error: Error | null;
  errorInfo: ErrorInfo | null;
  onReset: () => void;
}) => {
  const styles = useStyles();

  return (
    <div className={styles.container}>
      <Card className={styles.card}>
        <ErrorCircle24Filled className={styles.icon} />
        <Title1 className={styles.title}>Something went wrong</Title1>
        <Body1 className={styles.message}>
          An unexpected error occurred. Please try refreshing the page.
        </Body1>
        {error && (
          <div className={styles.details}>
            <strong>Error:</strong> {error.message}
            {errorInfo?.componentStack && (
              <>
                {"\n\n"}
                <strong>Component Stack:</strong>
                {errorInfo.componentStack.slice(0, 500)}
                {errorInfo.componentStack.length > 500 && "..."}
              </>
            )}
          </div>
        )}
        <div className={styles.actions}>
          <Button
            appearance="primary"
            icon={<ArrowClockwise24Regular />}
            onClick={() => window.location.reload()}
          >
            Refresh Page
          </Button>
          <Button appearance="secondary" onClick={onReset}>
            Try Again
          </Button>
        </div>
      </Card>
    </div>
  );
};

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
    this.setState({ errorInfo });
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <ErrorDisplay
          error={this.state.error}
          errorInfo={this.state.errorInfo}
          onReset={this.handleReset}
        />
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
