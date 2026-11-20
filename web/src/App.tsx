import {
  createBrowserRouter,
  Navigate,
  type RouteObject,
  RouterProvider
} from "react-router"
import { Toaster } from "@/components/ui/sonner"
import { AppShell } from "@/components/app-shell"
import {
  RootGate,
  GuestOnly,
  RequireAdmin,
  RequireAuth,
  RequirePasswordChanged
} from "@/components/guards"
import { ThemeProvider } from "@/components/theme-provider"
import { AboutPage } from "@/pages/about"
import {
  AdminIndexRedirect,
  AdminPage,
  AdminUsersTab
} from "@/pages/admin/admin-page"
import { EmailSection } from "@/pages/admin/email-section"
import { FileLimitsSection } from "@/pages/admin/file-limits-section"
import { OthersSection } from "@/pages/admin/others-section"
import { RegistrationSection } from "@/pages/admin/registration-section"
import { ForgotPasswordPage } from "@/pages/auth/forgot-password"
import { LoginPage } from "@/pages/auth/login"
import { RegisterPage } from "@/pages/auth/register"
import { ChangePasswordPage } from "@/pages/change-password"
import { HomePage } from "@/pages/home"
import { NotFoundPage } from "@/pages/not-found"
import { ProfilePage } from "@/pages/profile"
import { SettingsPage } from "@/pages/settings"
import { PreferencesSection } from "@/pages/settings/preferences-section"
import { SecuritySection } from "@/pages/settings/security-section"
import { SetupPage } from "@/pages/setup"
import { WorkbenchPage } from "@/pages/workbench"

export const routes: RouteObject[] = [
  {
    element: <RootGate />,
    children: [
      {
        element: <GuestOnly />,
        children: [
          { path: "/", element: <HomePage /> },
          { path: "/login", element: <LoginPage /> },
          { path: "/register", element: <RegisterPage /> },
          { path: "/forgot-password", element: <ForgotPasswordPage /> }
        ]
      },
      { path: "/setup", element: <SetupPage /> },
      {
        element: <RequireAuth />,
        children: [
          { path: "/change-password", element: <ChangePasswordPage /> },
          {
            element: <RequirePasswordChanged />,
            children: [
              {
                element: <AppShell />,
                children: [
                  { path: "/workbench", element: <WorkbenchPage /> },
                  { path: "/profile", element: <ProfilePage /> },
                  {
                    path: "/settings",
                    element: <SettingsPage />,
                    children: [
                      {
                        index: true,
                        element: <Navigate to="/settings/security" replace />
                      },
                      { path: "security", element: <SecuritySection /> },
                      { path: "preferences", element: <PreferencesSection /> },
                      {
                        path: "*",
                        element: <Navigate to="/settings/security" replace />
                      }
                    ]
                  },
                  { path: "/about", element: <AboutPage /> },
                  {
                    element: <RequireAdmin />,
                    children: [
                      {
                        path: "/admin",
                        element: <AdminPage />,
                        children: [
                          {
                            index: true,
                            element: <AdminIndexRedirect />
                          },
                          { path: "email", element: <EmailSection /> },
                          {
                            path: "registration",
                            element: <RegistrationSection />
                          },
                          { path: "users", element: <AdminUsersTab /> },
                          { path: "limits", element: <FileLimitsSection /> },
                          {
                            path: "others",
                            element: <OthersSection />
                          },
                          {
                            path: "*",
                            element: <Navigate to="/admin/email" replace />
                          }
                        ]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      },
      { path: "*", element: <NotFoundPage /> }
    ]
  }
]

const router = createBrowserRouter(routes)

export function App() {
  return (
    <ThemeProvider>
      <RouterProvider router={router} />
      <Toaster position="top-center" />
    </ThemeProvider>
  )
}
