import { lazyWithRetry } from "@/utils/lazyWithRetry";
import { Toaster } from "@/components/ui/toaster";
import { Suspense, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { FluentThemeProvider } from "@/providers/FluentThemeProvider";
import { AppAuthProvider } from "@/providers/AppAuthProvider";
import { UltraBlurProvider } from "@/providers/UltraBlurProvider";
import { QueueStatusProvider } from "@/providers/QueueStatusProvider";
import AppBootstrapGate from "@/components/AppBootstrapGate";
import Layout from "@/components/Layout";
import ErrorBoundary from "@/components/ErrorBoundary";
import PageErrorBoundary from "@/components/PageErrorBoundary";
import RouteLoadingFallback from "@/components/loading/RouteLoadingFallback";

// Lazy-loaded pages for code splitting
const Auth = lazyWithRetry(() => import("@/pages/Auth"));
const AdminLogin = lazyWithRetry(() => import("@/pages/AdminLogin"));
const Library = lazyWithRetry(() => import("@/pages/Library"));
const ArtistPage = lazyWithRetry(() => import("@/pages/ArtistPage"));
const AlbumPage = lazyWithRetry(() => import("@/pages/AlbumPage"));
const Dashboard = lazyWithRetry(() => import("@/pages/dashboard"));
const VideoPage = lazyWithRetry(() => import("@/pages/VideoPage"));
const SettingsPage = lazyWithRetry(() => import("@/pages/SettingsPage"));
const StatusPage = lazyWithRetry(() => import("@/pages/StatusPage"));
const NotFound = lazyWithRetry(() => import("@/pages/NotFound"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10000),
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

const PageFallback = () => <RouteLoadingFallback />;

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
        <FluentThemeProvider defaultTheme="system" storageKey="discogenius-theme">
          <AppAuthProvider>
            <UltraBlurProvider>
              <QueueStatusProvider>
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

                    <Route element={<AppBootstrapGate />}>
                      <Route element={<Layout />}>
                        <Route
                          path="/auth"
                          element={
                            <SuspendedPage>
                              <Auth />
                            </SuspendedPage>
                          }
                        />
                        <Route
                          path="/"
                          element={
                            <SuspendedPage pageName="Library">
                              <Library />
                            </SuspendedPage>
                          }
                        />
                        <Route
                          path="/library"
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
                        <Route
                          path="/system/status"
                          element={
                            <SuspendedPage pageName="Status">
                              <StatusPage />
                            </SuspendedPage>
                          }
                        />

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
              </QueueStatusProvider>
            </UltraBlurProvider>
          </AppAuthProvider>
        </FluentThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
};

export default App;
