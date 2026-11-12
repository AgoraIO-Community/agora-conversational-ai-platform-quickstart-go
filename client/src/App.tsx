import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Loader2,
  LogOut,
  Shield,
  Sparkles,
  TriangleAlert,
  User,
} from "lucide-react";

import {
  AgentStudioPanel,
  type StudioWorkflowStage,
} from "@/components/agent-studio-panel";
import { StudioCallPanel } from "@/components/studio-call-panel";
import { StudioCallHistory } from "@/components/studio-call-history";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { isValidPhoneNumber } from "@/components/phone-field";
import { ProjectSwitcher } from "@/components/project-switcher";

const PLATFORM_DOCS_URL = "https://docs.agora.io/en/ai/platform";

type Outcome =
  | { status: "idle" }
  | {
      status: "success";
      agentSessionId: string;
      calleeE164: string;
    }
  | { status: "error"; message: string };

type MeState =
  | null
  | { authenticated: false; authMode: "sso" | "bypass" }
  | {
      authenticated: true;
      authMode: "sso" | "bypass";
      user: { id: string; email: string; name: string };
    };

export default function Home() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeState>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [calleeE164, setCalleeE164] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [selectedPhoneNumberId, setSelectedPhoneNumberId] = useState("");
  const [selectedAgentName, setSelectedAgentName] = useState("");
  const [selectedProjectAppId, setSelectedProjectAppId] = useState("");
  const selectedProjectAppIdRef = useRef("");
  const [workflowStage, setWorkflowStage] =
    useState<StudioWorkflowStage>("agents");

  useEffect(() => {
    const syncWorkflowFromPath = () => {
      const [, studio, stageSegment, agentIdSegment] =
        window.location.pathname.split("/");
      if (studio !== "studio") {
        setWorkflowStage("agents");
        setSelectedAgentId("");
        return;
      }

      const supportedStages: StudioWorkflowStage[] = [
        "agents",
        "agent",
        "phone",
        "test",
        "campaign",
      ];
      if (supportedStages.includes(stageSegment as StudioWorkflowStage)) {
        setWorkflowStage(stageSegment as StudioWorkflowStage);
      }
      setSelectedAgentId(
        stageSegment !== "agents" && agentIdSegment
          ? decodeURIComponent(agentIdSegment)
          : "",
      );
    };

    syncWorkflowFromPath();
    window.addEventListener("popstate", syncWorkflowFromPath);
    return () => window.removeEventListener("popstate", syncWorkflowFromPath);
  }, []);

  const selectAgent = useCallback((agentId: string) => {
    setSelectedAgentId(agentId);
    if (!agentId) return;

    setWorkflowStage("agent");
    void navigate({
      to: "/studio/$stage/$agentId",
      params: { stage: "agent", agentId },
    });
  }, [navigate]);

  const navigateToAgentStage = useCallback(
    (
      agentId: string,
      nextStage: StudioWorkflowStage,
      sectionId?: string,
    ) => {
      if (!agentId) return;
      setSelectedAgentId(agentId);
      setWorkflowStage(nextStage);
      void navigate({
        to: "/studio/$stage/$agentId",
        params: { stage: nextStage, agentId },
        hash: sectionId ? sectionId : "",
      });
      if (sectionId) {
        window.setTimeout(() => {
          document.getElementById(sectionId)?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        }, 0);
      }
    },
    [navigate],
  );
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ status: "idle" });
  const [callComplete, setCallComplete] = useState(false);

  const navigateWorkflowStage = useCallback(
    (nextStage: StudioWorkflowStage) => {
      const currentPathAgentId = window.location.pathname.split("/")[3];
      const scopedAgentId =
        selectedAgentId ||
        (currentPathAgentId
          ? decodeURIComponent(currentPathAgentId)
          : "");
      const nextPath =
        nextStage !== "agents" && scopedAgentId
          ? `/studio/${nextStage}/${encodeURIComponent(scopedAgentId)}`
          : `/studio/${nextStage}`;
      if (nextStage === workflowStage && nextPath === window.location.pathname) {
        return;
      }
      setWorkflowStage(nextStage);
      if (nextStage !== "agents" && scopedAgentId) {
        void navigate({
          to: "/studio/$stage/$agentId",
          params: { stage: nextStage, agentId: scopedAgentId },
        });
      } else {
        void navigate({
          to: "/studio/$stage",
          params: { stage: nextStage },
        });
      }
    },
    [navigate, selectedAgentId, workflowStage],
  );

  const changeProject = useCallback(
    (appId: string) => {
      const isProjectSwitch =
        Boolean(selectedProjectAppIdRef.current) &&
        selectedProjectAppIdRef.current !== appId;
      selectedProjectAppIdRef.current = appId;
      setSelectedProjectAppId(appId);
      if (!isProjectSwitch) return;

      setSelectedAgentId("");
      setSelectedPhoneNumberId("");
      setWorkflowStage("agents");
      setOutcome({ status: "idle" });
      void navigate({
        to: "/studio/$stage",
        params: { stage: "agents" },
      });
    },
    [navigate],
  );
  const refreshMe = useCallback(async () => {
    try {
      const controller = new AbortController();
      const abortTimer = window.setTimeout(() => controller.abort(), 12_000);
      const res = await fetch("/api/session/me", {
        signal: controller.signal,
        cache: "no-store",
      });
      window.clearTimeout(abortTimer);
      const data = (await res.json()) as {
        authenticated?: boolean;
        authMode?: "sso" | "bypass";
        user?: { id: string; email: string; name: string };
      };

      if (!data || data.authenticated !== true || !data.user) {
        const mode = data?.authMode === "bypass" ? "bypass" : "sso";
        setMe({ authenticated: false, authMode: mode });
        return;
      }

      setMe({
        authenticated: true,
        authMode: data.authMode === "bypass" ? "bypass" : "sso",
        user: data.user,
      });
    } catch {
      setMe({ authenticated: false, authMode: "sso" });
    }
  }, []);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const reason = url.searchParams.get("authError");
    if (!reason) return;
    setAuthError(
      reason === "exchange_failed"
        ? "Sign-in could not be completed. Please try again."
        : `Sign-in failed (${reason}). Please try again.`,
    );
    url.searchParams.delete("authError");
    window.history.replaceState({}, "", url.pathname + url.search);
  }, []);

  async function handleSignOut() {
    try {
      const res = await fetch("/api/auth/agora/logout", { method: "POST" });
      const data = (await res.json()) as { redirect?: string };
      window.location.href =
        typeof data.redirect === "string" ? data.redirect : "/";
    } catch {
      window.location.href = "/";
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!calleeE164 || !isValidPhoneNumber(calleeE164)) {
      return;
    }

    setLoading(true);
    setOutcome({ status: "idle" });
    setCallComplete(false);
    try {
      const res = await fetch("/api/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: calleeE164,
          agentId: selectedAgentId,
          phoneNumberId: selectedPhoneNumberId,
        }),
      });
      const data: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const d =
          typeof data === "object" && data !== null
            ? (data as {
                error?: unknown;
                reason?: unknown;
                message?: unknown;
              })
            : {};
        const parts = [
          typeof d.error === "string" ? d.error : `Request failed (${res.status})`,
          typeof d.reason === "string" ? d.reason : null,
        ].filter((p): p is string => Boolean(p));
        throw new Error(parts.join(" — "));
      }

      const ok = data as { agentSessionId?: unknown };
      const agentSessionId =
        typeof ok.agentSessionId === "string" ? ok.agentSessionId : "";
      if (!agentSessionId) {
        throw new Error("Server response did not include an agent session ID.");
      }

      setOutcome({
        status: "success",
        agentSessionId,
        calleeE164,
      });
    } catch (err) {
      setOutcome({
        status: "error",
        message: err instanceof Error ? err.message : "Something went wrong.",
      });
    } finally {
      setLoading(false);
    }
  }

  if (me === null) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3">
        <Loader2 className="text-muted-foreground size-8 animate-spin" />
        <p className="text-muted-foreground text-sm">Loading session…</p>
      </div>
    );
  }

  if (!me.authenticated) {
    return (
      <div className="from-background via-background to-muted/15 flex min-h-screen flex-col items-center justify-center gap-4 bg-gradient-to-b px-4">
        <a
          href={PLATFORM_DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="border-border/70 bg-card/65 text-muted-foreground hover:text-foreground inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-sm backdrop-blur-sm transition"
        >
          Open Platform docs
        </a>
        <Card className="w-full max-w-md border-border/80 shadow-lg">
          <CardHeader className="space-y-2 text-center">
            <div className="mx-auto flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Shield className="size-5" aria-hidden />
            </div>
            <CardTitle className="text-2xl">Sign in with Agora</CardTitle>
            <CardDescription>
              Use your Agora account to place PSTN calls and use the voice agent
              demo.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {authError && (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertDescription>{authError}</AlertDescription>
              </Alert>
            )}
            <Button
              type="button"
              size="lg"
              className="w-full"
              onClick={() => {
                window.location.href = "/api/auth/agora/start";
              }}
            >
              Sign in with Agora
            </Button>
            <p className="text-muted-foreground text-center text-xs">
              You will be redirected to Agora SSO and returned to this app.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="from-background via-background to-muted/15 relative min-h-screen bg-gradient-to-b">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(8,72,138,0.12),transparent)]" />

      <main className="relative mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:py-14">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <ProjectSwitcher onProjectChange={changeProject} />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <a
              href={PLATFORM_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="border-border/80 bg-card/60 text-muted-foreground inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-sm backdrop-blur-sm transition hover:text-foreground"
            >
              Open Platform docs
            </a>
            <div className="border-border/80 bg-card/60 text-muted-foreground flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-sm backdrop-blur-sm">
              <User className="size-3.5 shrink-0" aria-hidden />
              <span className="text-foreground max-w-[200px] truncate">
                {me.user.email || me.user.name || me.user.id}
              </span>
              <button
                type="button"
                onClick={() => void handleSignOut()}
                className="text-muted-foreground hover:text-foreground rounded-full p-1 transition"
                title="Sign out"
                aria-label="Sign out"
              >
                <LogOut className="size-3.5" />
              </button>
            </div>
          </div>
        </div>

        <header className="mb-10 max-w-2xl space-y-4">
          <div className="flex items-center gap-2 text-xs font-medium tracking-widest text-muted-foreground uppercase">
            <Shield className="size-3.5" aria-hidden />
            Agora Conversational AI v3 APIs
          </div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Build, test, and launch outbound voice agents
          </h1>
          <p className="text-muted-foreground max-w-xl text-sm leading-relaxed sm:text-base">
            Explore the v3 APIs end to end: save agents, manage secrets and
            phone numbers, place one-off test calls, and launch outbound
            calling campaigns.
          </p>
        </header>

        {selectedProjectAppId ? (
          <AgentStudioPanel
            key={selectedProjectAppId}
            stage={workflowStage}
            onStageChange={navigateWorkflowStage}
            selectedAgentId={selectedAgentId}
            onAgentChange={selectAgent}
            onAgentNavigate={navigateToAgentStage}
            onAgentNameChange={setSelectedAgentName}
            selectedPhoneNumberId={selectedPhoneNumberId}
            onPhoneNumberChange={setSelectedPhoneNumberId}
            testDestination={calleeE164}
            onTestDestinationChange={setCalleeE164}
            onTestCall={onSubmit}
            testCallLoading={loading}
          />
        ) : (
          <Card className="mb-10">
            <CardContent className="text-muted-foreground flex min-h-40 items-center justify-center gap-2">
              <Loader2 className="animate-spin" /> Loading customer project
            </CardContent>
          </Card>
        )}

        {workflowStage === "test" && (
        <div className="mt-8">
          <div className="space-y-6">
            {outcome.status === "error" && (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertTitle>Couldn&apos;t start the call</AlertTitle>
                <AlertDescription>{outcome.message}</AlertDescription>
              </Alert>
            )}

            {outcome.status === "success" && (
              <StudioCallPanel
                key={outcome.agentSessionId}
                agentSessionId={outcome.agentSessionId}
                calleeE164={outcome.calleeE164}
                onCompleteChange={setCallComplete}
              />
            )}

            {outcome.status !== "success" && outcome.status !== "error" && (
              <Card className="border-dashed border-border/80 bg-muted/15">
                <CardHeader className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="bg-primary/12 text-primary flex size-9 items-center justify-center rounded-lg">
                      <Sparkles className="size-4" aria-hidden />
                    </span>
                    <div>
                      <CardTitle className="text-base">Live timeline</CardTitle>
                      <CardDescription>
                        After you place a call, the v3 session status and its
                        post-call analysis appear here automatically.
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            )}
            <StudioCallHistory
              agentName={selectedAgentName}
              refreshKey={
                outcome.status === "success"
                  ? `${outcome.agentSessionId}:${callComplete}`
                  : undefined
              }
            />
          </div>
        </div>
        )}
      </main>
    </div>
  );
}
