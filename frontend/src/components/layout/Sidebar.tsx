"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Database, Terminal, BrainCircuit, Layers,
  FolderOpen, ShieldCheck, LogOut, GitBranch, Clock, KeyRound, Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/context/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { toast } from "sonner";

const BASE_NAV = [
  { href: "/database-config", label: "Connections",   icon: Database },
  { href: "/data-studio",     label: "Data Studio",   icon: Terminal },
  { href: "/data-lineage",    label: "Data Lineage",  icon: GitBranch },
  { href: "/orchestration",   label: "Orchestration", icon: Clock },
  { href: "/design",          label: "Design",        icon: Layers },
  { href: "/projects",        label: "Projects",      icon: FolderOpen },
];

function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [current, setCurrent]   = useState("");
  const [next, setNext]         = useState("");
  const [confirm, setConfirm]   = useState("");
  const [saving, setSaving]     = useState(false);

  function reset() { setCurrent(""); setNext(""); setConfirm(""); }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) { toast.error("New passwords do not match"); return; }
    if (next.length < 8)  { toast.error("Password must be at least 8 characters"); return; }
    setSaving(true);
    try {
      await api.changePassword(current, next);
      toast.success("Password changed");
      reset();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) { reset(); onClose(); } }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> Change Password
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3 mt-1">
          <div className="space-y-1.5">
            <Label className="text-xs">Current password</Label>
            <Input type="password" value={current} onChange={e => setCurrent(e.target.value)} required autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">New password</Label>
            <Input type="password" value={next} onChange={e => setNext(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Confirm new password</Label>
            <Input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required />
          </div>
          <div className="flex gap-2 justify-end pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => { reset(); onClose(); }}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving || !current || !next || !confirm}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
              Change password
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const [changePwOpen, setChangePwOpen] = useState(false);

  function handleLogout() {
    logout();
    router.replace("/login");
  }

  const nav = [
    ...BASE_NAV,
    ...(user?.role === "sysadmin"
      ? [{ href: "/admin", label: "Admin", icon: ShieldCheck }]
      : []),
  ];

  return (
    <>
      <aside className="flex h-screen w-56 flex-col border-r border-border bg-card">
        {/* Logo */}
        <div className="flex items-center gap-2 px-4 py-5 border-b border-border">
          <BrainCircuit className="h-6 w-6 text-primary" />
          <span className="font-semibold text-sm tracking-tight">DW Builder</span>
        </div>

        {/* Nav links */}
        <nav className="flex-1 px-2 py-4 space-y-1">
          {nav.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                pathname === href || pathname.startsWith(href + "/")
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          ))}
        </nav>

        {/* User info + actions */}
        <div className="px-3 py-3 border-t border-border space-y-1">
          {user && (
            <div className="px-2 py-1">
              <p className="text-xs font-medium truncate">{user.name}</p>
              <p className="text-[10px] text-muted-foreground truncate">{user.email}</p>
            </div>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setChangePwOpen(true)}
            className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground h-8 px-2"
          >
            <KeyRound className="h-3.5 w-3.5" />
            Change password
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground h-8 px-2"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </Button>
        </div>
      </aside>

      <ChangePasswordDialog open={changePwOpen} onClose={() => setChangePwOpen(false)} />
    </>
  );
}
