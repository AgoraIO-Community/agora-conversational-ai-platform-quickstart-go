import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, RefreshCw, Settings2 } from "lucide-react";

import { SessionAnalysisView } from "@/components/studio-call-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  formatTimestamp,
  listItems,
  sessionIsFinal,
  v3Fetch,
  type SessionDetail,
} from "@/components/v3-api";
import { cn } from "@/lib/utils";

export function StudioCallHistory({
  agentName,
  refreshKey,
}: {
  /** Session lists have no agent filter, so sessions are matched by agent name. */
  agentName: string;
  refreshKey?: string;
}) {
  const [sessions, setSessions] = useState<SessionDetail[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const requestRef = useRef(0);

  const loadSessions = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!agentName) {
      setSessions([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const page = await v3Fetch(
        "sessions?status=RUNNING,STOPPED,FAILED&limit=20",
      );
      // List items carry only id/status/start time; load details for name + analysis.
      const summaries = listItems<SessionDetail>(page);
      const details = await Promise.all(
        summaries.map((summary) =>
          v3Fetch<SessionDetail>(
            `sessions/${encodeURIComponent(summary.agent_session_id)}`,
          ).catch(() => summary),
        ),
      );
      const next = details
        .filter((session) => session.agent_name === agentName)
        .sort((a, b) => (b.start_ts || 0) - (a.start_ts || 0));
      if (requestRef.current === requestId) setSessions(next);
    } catch (loadError) {
      if (requestRef.current === requestId) {
        setError(
          loadError instanceof Error ? loadError.message : "Could not load sessions.",
        );
      }
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [agentName]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions, refreshKey]);

  return (
    <Card className="border-border/80 shadow-lg">
      <CardHeader className="border-border/80 border-b bg-card/80">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-lg">Session history</CardTitle>
            <CardDescription>
              Recent sessions for the selected agent, matched by agent name.
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadSessions()}
            disabled={loading || !agentName}
          >
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-5">
        {error && (
          <Alert variant="destructive" className="mb-4">
            <Settings2 />
            <AlertTitle>Session history unavailable</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading && sessions.length === 0 ? (
          <div className="text-muted-foreground flex min-h-28 items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm">
            <Loader2 className="size-4 animate-spin" /> Loading sessions
          </div>
        ) : sessions.length === 0 ? (
          <div className="text-muted-foreground rounded-xl border border-dashed border-border px-5 py-8 text-center text-sm">
            No recent sessions for this agent yet.
          </div>
        ) : (
          <div className="space-y-3">
            {sessions.map((session) => {
              const status = (session.status || "unknown").toLowerCase();
              const final = sessionIsFinal(session.status);
              const expanded = expandedId === session.agent_session_id;
              return (
                <div
                  key={session.agent_session_id}
                  className="rounded-xl border border-border bg-muted/15 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs" title={session.agent_session_id}>
                        {session.agent_session_id}
                      </p>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {formatTimestamp(session.start_ts)}
                        {session.stop_ts != null && session.start_ts != null
                          ? ` · ${Math.max(0, Math.round((session.stop_ts - session.start_ts) / (session.start_ts > 10_000_000_000 ? 1000 : 1)))}s`
                          : ""}
                      </p>
                      {session.message && (
                        <p className="text-muted-foreground mt-1 text-xs">{session.message}</p>
                      )}
                    </div>
                    <Badge
                      variant="outline"
                      className={cn(
                        "capitalize",
                        final
                          ? "border-border text-muted-foreground"
                          : "border-accent/35 text-accent",
                        status === "failed" && "border-red-400/35 text-red-400",
                      )}
                    >
                      {status}
                    </Badge>
                  </div>
                  <div className="mt-3 flex justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setExpandedId(expanded ? null : session.agent_session_id)
                      }
                    >
                      <ChevronDown className={cn("transition", expanded && "rotate-180")} />
                      {expanded ? "Hide analysis" : "View analysis"}
                    </Button>
                  </div>
                  {expanded && (
                    <div className="mt-3 border-t border-border pt-3">
                      <SessionAnalysisView analysis={session.analysis} final={final} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
