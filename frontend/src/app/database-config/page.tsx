"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { ConnectionForm } from "@/components/database/ConnectionForm";
import { ConnectionList } from "@/components/database/ConnectionList";
import { api } from "@/lib/api";
import type { Connection } from "@/lib/types";
import { toast } from "sonner";

export default function DatabaseConfigPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const searchParams = useSearchParams();

  async function refresh() {
    try {
      setConnections(await api.listConnections());
    } catch {
      // backend not reachable yet
    }
  }

  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    if (searchParams.get("bq_connected") === "1") {
      toast.success("Google BigQuery connected successfully");
      refresh();
      // Clean the query param from the URL without a page reload
      const url = new URL(window.location.href);
      url.searchParams.delete("bq_connected");
      window.history.replaceState({}, "", url.toString());
    }
  }, [searchParams]);

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Database Connections</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Configure your Azure SQL connection to get started.
        </p>
      </div>

      <ConnectionForm onSaved={refresh} />
      <ConnectionList connections={connections} onChanged={refresh} />
    </div>
  );
}
