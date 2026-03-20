import { lazy, Suspense, type ReactNode } from "react";
import { makeStyles } from "@fluentui/react-components";
import { Toaster } from "@/components/ui/toaster";
import { LoadingState } from "@/components/ui/LoadingState";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { FluentThemeProvider } from "@/providers/FluentThemeProvider";
import { AppAuthProvider } from "@/providers/AppAuthProvider";
import { UltraBlurProvider } from "@/providers/UltraBlurProvider";
import { QueueProvider } from "@/providers/QueueProvider";
import Layout from "@/components/Layout";
import ProtectedRoute from "@/components/ProtectedRoute";
import AppAuthGate from "@/components/AppAuthGate";
import ErrorBoundary from "@/components/ErrorBoundary";
import PageErrorBoundary from "@/components/PageErrorBoundary";

// Lazy-loaded pages for code splitting
const Auth = lazy(() => import("@/pages/Auth"));
const AdminLogin = lazy(() => import("@/pages/AdminLogin"));
const Library = lazy(() => import("@/pages/Library"));
const ArtistPage = lazy(() => import("@/pages/ArtistPage"));
const AlbumPage = lazy(() => import("@/pages/AlbumPage"));
const Dashboard = lazy(() => import("@/pages/dashboard"));
const SearchPage = lazy(() => import("@/pages/SearchPage"));
const VideoPage = lazy(() => import("@/pages/VideoPage"));
const SettingsPage = lazy(() => import("@/pages/SettingsPage"));
const NotFound = lazy(() => import("@/pages/NotFound"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10000),
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

const useStyles = makeStyles({
  suspenseFallback: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "60vh",
  },
});

const PageFallback = () => {
  const styles = useStyles();
  return (
    <LoadingState className={styles.suspenseFallback} label="Loading page..." />
  );
};

const SuspendedPage = ({
  children,
  pageName,
}: {
  children: ReactNode;
  pageName?: string;
}) => (
  <Suspense fallback={<PageFallback />}>
    {pageName ? (
      <PageErrorBoundary pageName={pageName}>{children}</PageErrorBoundary>
    ) : (
      children
    )}
  </Suspense>
);

const App = () => {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <FluentThemeProvider defaultTheme="dark" storageKey="discogenius-theme">
          <AppAuthProvider>
            <UltraBlurProvider>
              <QueueProvider>
                <Toaster />
                <BrowserRouter future={{ v7_relativeSplatPath: true }}>
                  <Routes>
                    <Route
                      path="/login"
                      element={
                        <SuspendedPage>
                          <AdminLogin />
                        </SuspendedPage>
                      }
                    />

                    <Route element={<Layout />}>
                      <Route element={<AppAuthGate />}>
                        <Route
                          path="/auth"
                          element={
                            <SuspendedPage>
                              <Auth />
                            </SuspendedPage>
                          }
                        />
                        <Route element={<ProtectedRoute />}>
                          <Route
                            path="/"
                            element={
                              <SuspendedPage pageName="Library">
                                <Library />
                              </SuspendedPage>
                            }
                          />
                          <Route
                            path="/artist/:artistId"
                            element={
                              <SuspendedPage pageName="Artist">
                                <ArtistPage />
                              </SuspendedPage>
                            }
                          />
                          <Route
                            path="/album/:albumId"
                            element={
                              <SuspendedPage pageName="Album">
                                <AlbumPage />
                              </SuspendedPage>
                            }
                          />
                          <Route
                            path="/video/:videoId"
                            element={
                              <SuspendedPage pageName="Video">
                                <VideoPage />
                              </SuspendedPage>
                            }
                          />
                          <Route
                            path="/search"
                            element={
                              <SuspendedPage pageName="Search">
                                <SearchPage />
                              </SuspendedPage>
                            }
                          />
                          <Route
                            path="/dashboard"
                            element={
                              <SuspendedPage pageName="Dashboard">
                                <Dashboard />
                              </SuspendedPage>
                            }
                          />
                          <Route
                            path="/settings"
                            element={
                              <SuspendedPage pageName="Settings">
                                <SettingsPage />
                              </SuspendedPage>
                            }
                          />
                        </Route>

                        {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
                        <Route
                          path="*"
                          element={
                            <SuspendedPage>
                              <NotFound />
                            </SuspendedPage>
                          }
                        />
                      </Route>
                    </Route>
                  </Routes>
                </BrowserRouter>
              </QueueProvider>
            </UltraBlurProvider>
          </AppAuthProvider>
        </FluentThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
};

export default App;
