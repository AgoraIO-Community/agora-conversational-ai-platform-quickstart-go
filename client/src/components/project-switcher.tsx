import { FormEvent, useEffect, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Project = {
  id: string;
  name: string;
  appId: string;
  status: 0 | 1;
  created: number | null;
};

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value !== "object" || value === null) return fallback;
  const error = (value as { error?: unknown }).error;
  return typeof error === "string" && error ? error : fallback;
}

export function ProjectSwitcher({
  onProjectChange,
}: {
  onProjectChange: (appId: string) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedAppId, setSelectedAppId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  // False when the server has no Console credentials: only AGORA_APP_ID is available.
  const [canManageProjects, setCanManageProjects] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/projects", { cache: "no-store" })
      .then(async (response) => {
        const data: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(
            errorMessage(data, `Project request failed (${response.status})`),
          );
        }
        if (cancelled) return;
        const result = data as {
          projects?: unknown;
          selectedAppId?: unknown;
          consoleEnabled?: unknown;
        };
        const nextProjects = Array.isArray(result.projects)
          ? (result.projects as Project[])
          : [];
        const nextAppId =
          typeof result.selectedAppId === "string" ? result.selectedAppId : "";
        setProjects(nextProjects);
        setCanManageProjects(result.consoleEnabled !== false);
        setSelectedAppId(nextAppId);
        onProjectChange(nextAppId);
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Could not load projects.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onProjectChange]);

  async function selectProject(appId: string) {
    if (!appId || appId === selectedAppId) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/projects", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId }),
      });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          errorMessage(data, `Project switch failed (${response.status})`),
        );
      }
      setSelectedAppId(appId);
      onProjectChange(appId);
    } catch (switchError) {
      setError(
        switchError instanceof Error
          ? switchError.message
          : "Could not switch projects.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function createProject(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          errorMessage(data, `Project creation failed (${response.status})`),
        );
      }
      const result = data as {
        project?: Project;
        selectedAppId?: string;
      };
      if (!result.project || !result.selectedAppId) {
        throw new Error("Agora did not return the created project.");
      }
      setProjects((current) => [...current, result.project!]);
      setSelectedAppId(result.selectedAppId);
      setName("");
      setCreating(false);
      onProjectChange(result.selectedAppId);
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : "Could not create the project.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <div className="border-border/80 bg-card/70 flex h-9 min-w-56 items-center rounded-full border px-3 shadow-sm backdrop-blur-sm transition focus-within:border-accent/45 focus-within:ring-2 focus-within:ring-accent/10 hover:border-accent/35">
          <Label
            htmlFor="project-switcher"
            className="text-muted-foreground shrink-0 text-[10px] font-semibold uppercase tracking-wider"
          >
            Project
          </Label>
          <span className="bg-border mx-2 h-4 w-px" aria-hidden />
          <select
            id="project-switcher"
            className="h-full min-w-0 flex-1 cursor-pointer bg-transparent text-sm font-medium outline-none disabled:cursor-wait"
            value={selectedAppId}
            disabled={loading || saving}
            onChange={(event) => void selectProject(event.target.value)}
          >
            {loading && <option value="">Loading projects…</option>}
            {!loading && projects.length === 0 && (
              <option value="">No projects</option>
            )}
            {projects.map((project) => (
              <option key={project.id} value={project.appId}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
        {canManageProjects && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="rounded-full bg-card/70 shadow-sm backdrop-blur-sm"
            aria-label="Create customer project"
            disabled={loading || saving}
            onClick={() => setCreating((current) => !current)}
          >
            {saving ? <Loader2 className="animate-spin" /> : creating ? <X /> : <Plus />}
          </Button>
        )}
      </div>
      {creating && canManageProjects && (
        <form
          onSubmit={createProject}
          className="bg-popover absolute top-full left-0 z-50 mt-2 w-80 space-y-3 rounded-xl border border-border p-4 shadow-xl"
        >
          <div>
            <p className="text-sm font-semibold">Create customer project</p>
            <p className="text-muted-foreground mt-1 text-xs">
              The App Certificate is created and retained server-side.
            </p>
          </div>
          <Input
            autoFocus
            value={name}
            maxLength={255}
            placeholder="Customer project name"
            onChange={(event) => setName(event.target.value)}
            required
          />
          <Button type="submit" className="w-full" disabled={saving || !name.trim()}>
            {saving && <Loader2 className="animate-spin" />}
            Create and select
          </Button>
        </form>
      )}
      {error && (
        <p className="mt-1 max-w-80 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
