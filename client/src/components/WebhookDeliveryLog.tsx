import { useState, useEffect } from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, Button } from "@/components/dashboard-ui";
import { fetchApi } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { RefreshCw, CheckCircle2, XCircle, Clock } from "lucide-react";

type DeliveryEntry = {
  id: string;
  txId: string;
  txHash?: string;
  url: string;
  statusCode?: number;
  success: boolean;
  responseBody?: string;
  error?: string;
  sentAt: number;
};

export function WebhookDeliveryLog() {
  const { apiKey } = useAuth();
  const [entries, setEntries] = useState<DeliveryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = async () => {
    if (!apiKey) return;
    setLoading(true);
    try {
      const data = await fetchApi("/merchant/webhook/logs");
      if (Array.isArray(data)) setEntries(data);
    } catch {
      // silently fail — endpoint may not exist yet
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [apiKey]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="w-4 h-4 text-[#00D1A0]" />
              Webhook Delivery Log
            </CardTitle>
            <CardDescription className="mt-1">Recent webhook delivery attempts for your confirmed transactions.</CardDescription>
          </div>
          <Button variant="outline" size="icon" onClick={load} disabled={loading} title="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground text-sm">
            {loading ? "Loading..." : "No webhook deliveries yet. Deliveries appear here once a payment is confirmed."}
          </div>
        ) : (
          <div className="space-y-2">
            {entries.map(entry => (
              <div key={entry.id} className="rounded-lg border border-border overflow-hidden">
                <button
                  className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors"
                  onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                >
                  {entry.success
                    ? <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                    : <XCircle className="w-4 h-4 text-red-500 shrink-0" />
                  }
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${entry.success ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
                        {entry.statusCode ?? "ERR"}
                      </span>
                      <span className="text-xs font-mono text-muted-foreground truncate">{entry.url}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[11px] text-muted-foreground">
                        {new Date(entry.sentAt).toLocaleString()}
                      </span>
                      {entry.txHash && (
                        <span className="text-[11px] font-mono text-muted-foreground truncate">
                          tx: {entry.txHash.slice(0, 10)}…
                        </span>
                      )}
                    </div>
                  </div>
                  <svg className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform ${expanded === entry.id ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {expanded === entry.id && (
                  <div className="border-t border-border px-3 py-2.5 bg-muted/20 space-y-2">
                    {entry.error && (
                      <div>
                        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Error</p>
                        <pre className="text-xs text-red-600 bg-red-50 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">{entry.error}</pre>
                      </div>
                    )}
                    {entry.responseBody && (
                      <div>
                        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Response Body</p>
                        <pre className="text-xs bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-32">{entry.responseBody}</pre>
                      </div>
                    )}
                    <div>
                      <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Transaction ID</p>
                      <p className="text-xs font-mono">{entry.txId}</p>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
