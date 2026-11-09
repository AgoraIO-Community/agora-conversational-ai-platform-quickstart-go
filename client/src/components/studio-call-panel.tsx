import { useEffect, useState } from "react";
import { Loader2, PhoneCall, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  formatTimestamp,
  sessionIsFinal,
  v3Fetch,
  type SessionAnalysis,
  type SessionDetail,
} from "@/components/v3-api";

export function SessionAnalysisView({
  analysis,
  final,
}: {
  analysis?: SessionAnalysis | null;
  final: boolean;
}) {
  if (!analysis) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Sparkles className="size-4" />
        {final
          ? "No analysis was returned for this session."
          : "Analysis appears after the call ends, for variables marked extract."}
      </p>
    );
  }
  if (analysis.status !== "completed") {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        {analysis.status === "pending" && <Loader2 className="size-4 animate-spin" />}
        Analysis {analysis.status || "pending"}
        {analysis.skip_reason ? ` (${analysis.skip_reason.replaceAll("_", " ")})` : ""}
        {analysis.error ? `: ${analysis.error}` : "."}
      </p>
    );
  }
  const entries = Object.entries(analysis.result || {});
  if (entries.length === 0) {
    return <p className="text-muted-foreground text-sm">Analysis completed with no extracted values.</p>;
  }
  return (
    <dl className="grid gap-2 sm:grid-cols-2">
      {entries.map(([key, value]) => (
        <div key={key} className="rounded-lg border border-border bg-muted/20 px-3 py-2">
          <dt className="text-muted-foreground font-mono text-[11px]">{key}</dt>
          <dd className="mt-1 text-sm leading-relaxed">
            {typeof value === "string" ? value : JSON.stringify(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function StudioCallPanel({
  agentSessionId,
  calleeE164,
  onCompleteChange,
}: {
  agentSessionId: string;
  calleeE164: string;
  onCompleteChange?: (complete: boolean) => void;
}) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function poll() {
      try {
        const next = await v3Fetch<SessionDetail>(
          `sessions/${encodeURIComponent(agentSessionId)}`,
        );
        if (cancelled) return;
        setDetail(next);
        setError(null);
        const final = sessionIsFinal(next.status);
        onCompleteChange?.(final);
        // Keep polling after the call ends until post-call analysis settles.
        const analysisPending =
          !next.analysis || next.analysis.status === "pending";
        if (!final || analysisPending) {
          timer = window.setTimeout(poll, final ? 4000 : 2000);
        }
      } catch (pollError) {
        if (cancelled) return;
        setError(
          pollError instanceof Error ? pollError.message : "Could not load session status.",
        );
        timer = window.setTimeout(poll, 4000);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [agentSessionId, onCompleteChange]);

  const final = sessionIsFinal(detail?.status);

  return (
    <Card className="overflow-hidden border-border/80 shadow-lg">
      <CardHeader className="border-border/80 border-b bg-card/80">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <PhoneCall className="size-4 text-accent" /> Agent session
            </CardTitle>
            <CardDescription>
              {detail?.agent_name || "Saved agent"} to {calleeE164}
            </CardDescription>
          </div>
          <Badge variant={final ? "muted" : "success"} className="capitalize">
            {(detail?.status || "STARTING").toLowerCase()}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <div className="text-muted-foreground grid gap-1 text-xs sm:grid-cols-2">
          <span>Session: <code className="text-foreground">{agentSessionId}</code></span>
          {detail?.start_ts != null && <span>Started: {formatTimestamp(detail.start_ts)}</span>}
          {detail?.stop_ts != null && <span>Stopped: {formatTimestamp(detail.stop_ts)}</span>}
          {detail?.message && <span className="sm:col-span-2">Message: {detail.message}</span>}
        </div>
        {error && <p className="text-amber-400 text-xs">{error} Retrying...</p>}
        {!detail && !error ? (
          <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <Loader2 className="size-4 animate-spin" /> Waiting for the session...
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium">Post-call analysis</p>
            <SessionAnalysisView analysis={detail?.analysis} final={final} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
