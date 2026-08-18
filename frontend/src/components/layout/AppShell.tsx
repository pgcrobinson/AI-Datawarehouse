"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { Toaster } from "sonner";
import { useTheme } from "@/context/ThemeContext";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { theme } = useTheme();

  if (pathname === "/login") {
    return (
      <>
        {children}
        <Toaster theme={theme} position="bottom-right" richColors />
      </>
    );
  }

  return (
    <AuthGuard>
      <div className="flex h-screen overflow-hidden bg-background">
        <Sidebar />
        <main className="flex-1 overflow-auto bg-background">
          {children}
        </main>
      </div>
      <Toaster theme={theme} position="bottom-right" richColors />
    </AuthGuard>
  );
}
