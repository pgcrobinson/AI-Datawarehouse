"use client";

import { createContext, useContext, useState, useEffect, ReactNode } from "react";

const BASE = `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}/api`;

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "sysadmin" | "designer";
  org_id?: string;
  has_password: boolean;
}

interface AuthCtx {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  loginWithToken: (token: string) => Promise<void>;
  googleLogin: () => void;
  logout: () => void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem("dwb_token");
    if (!stored) { setLoading(false); return; }
    fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${stored}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => {
        if (u) { setToken(stored); setUser(u); }
        else localStorage.removeItem("dwb_token");
      })
      .catch(() => localStorage.removeItem("dwb_token"))
      .finally(() => setLoading(false));
  }, []);

  async function login(email: string, password: string) {
    const res = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: "Login failed" }));
      throw new Error(err.detail ?? "Login failed");
    }
    const data = await res.json();
    localStorage.setItem("dwb_token", data.token);
    setToken(data.token);
    setUser(data.user);
  }

  async function loginWithToken(tok: string) {
    const res = await fetch(`${BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error("Invalid or expired token");
    const u = await res.json();
    localStorage.setItem("dwb_token", tok);
    setToken(tok);
    setUser(u);
  }

  function googleLogin() {
    window.location.href = `${BASE}/auth/google/login`;
  }

  function logout() {
    localStorage.removeItem("dwb_token");
    setToken(null);
    setUser(null);
  }

  return (
    <Ctx.Provider value={{ user, token, loading, login, loginWithToken, googleLogin, logout }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}
