import { lazy, Suspense, type ReactNode } from "react";
import { Toaster } from "@/components/ui/toaster";
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
        <FluentThemeProvider defaultTheme="dark" storageKey="discogenius-theme">
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
