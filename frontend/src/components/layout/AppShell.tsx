"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { Toaster } from "sonner";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (pathname === "/login") {
    return (
      <>
        {children}
        <Toaster theme="dark" position="bottom-right" richColors />
      </>
    );
  }

  return (
    <AuthGuard>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto bg-background">
          {children}
        </main>
      </div>
      <Toaster theme="dark" position="bottom-right" richColors />
    </AuthGuard>
  );
}
