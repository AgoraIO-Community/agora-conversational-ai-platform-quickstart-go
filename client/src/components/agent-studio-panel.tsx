import { buildProviderParams, defaultProviderValues, ProviderConfigFields, providerValuesFromParams, type ProviderConfigValues } from "@/components/provider-config-fields";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  CalendarClock,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Megaphone,
  Pencil,
  Phone,
  RefreshCw,
  Rocket,
  Settings2,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isValidPhoneNumber, PhoneField } from "@/components/phone-field";
import { Textarea } from "@/components/ui/textarea";
import { formatTimestamp, v3Fetch, v3ListAll } from "@/components/v3-api";
import { cn } from "@/lib/utils";

type AgentSummary = {
  agent_id: string;
  agent_name?: string;
  instructions?: string | null;
  greeting?: { mode?: string; text?: string } | null;
  variables?: Record<string, unknown> | null;
  pipeline?: Record<string, unknown> | null;
  update_ts?: number;
};

type SecretSetSummary = {
  name: string;
  keys?: Array<string | { key?: string }>;
};

type PhoneNumberSummary = {
  number_id: string;
  number?: string;
  description?: string | null;
  sip_trunk?: {
    name?: string | null;
    hostname?: string;
    port?: number;
    transport?: string;
  } | null;
};

type CampaignSummary = {
  campaign_id: string;
  name?: string;
  status?: string;
  agent_id?: string;
  transport?: { from?: string | string[] };
  counts?: {
    contacts?: number;
    pending?: number;
    calling?: number;
    completed?: number;
    failed?: number;
    canceled?: number;
  };
  create_ts?: number;
  start_ts?: number | null;
  complete_ts?: number | null;
};

type CampaignConfirmation = {
  campaignId?: string;
  campaignName: string;
  recipientCount: number;
  startImmediately: boolean;
  scheduledStart?: string;
  timezone: string;
};

type Notice = {
  kind: "success" | "warning" | "error";
  message: string;
  placement?: "top" | "bottom";
} | null;

type CampaignContact = {
  phone: string;
  values?: Record<string, string>;
};

function parseCsvRows(value: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') {
      if (quoted && value[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(field.trim());
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && value[index + 1] === "\n") index += 1;
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function campaignContactsFromText(value: string): CampaignContact[] {
  const rows = parseCsvRows(value);
  if (rows.length === 0) return [];

  const headers = rows[0].map((header) =>
    header.replace(/^\uFEFF/, "").trim(),
  );
  const normalizedHeaders = headers.map((header) => header.toLowerCase());
  const phoneIndex = normalizedHeaders.indexOf("phone_number");

  if (phoneIndex >= 0) {
    return rows.slice(1).map((values, index) => {
      const phone = values[phoneIndex]?.trim() || "";
      if (!isValidPhoneNumber(phone)) {
        throw new Error(`CSV row ${index + 2} has an invalid phone_number.`);
      }
      // Extra columns become per-contact values for the agent's declared variables.
      const contactValues = Object.fromEntries(
        headers.flatMap((header, columnIndex) => {
          const cell = values[columnIndex]?.trim();
          return header && cell && columnIndex !== phoneIndex
            ? [[normalizedHeaders[columnIndex], cell]]
            : [];
        }),
      );
      return Object.keys(contactValues).length > 0
        ? { phone, values: contactValues }
        : { phone };
    });
  }

  return rows.map((values, index) => {
    const first = values[0]?.trim() || "";
    const second = values[1]?.trim() || "";
    const phone = isValidPhoneNumber(second) ? second : first;
    if (!isValidPhoneNumber(phone)) {
      throw new Error(`Recipient row ${index + 1} has an invalid phone number.`);
    }
    return phone === second && first
      ? { phone, values: { contact_name: first } }
      : { phone };
  });
}

type ProviderKind = "asr" | "llm" | "tts";

// A provider credential choice is "managed", "keep" (an existing write-only BYOK
// credential on a saved agent), or a `$secrets.<set>.<key>` reference.
const MANAGED_CREDENTIAL = "managed";
const KEEP_CREDENTIAL = "keep";
const SECRET_NAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

function secretKeys(set: SecretSetSummary): string[] {
  return (set.keys || [])
    .map((entry) => (typeof entry === "string" ? entry : entry.key || ""))
    .filter(Boolean);
}

function secretReferences(sets: SecretSetSummary[]): string[] {
  return sets.flatMap((set) =>
    secretKeys(set).map((key) => `$secrets.${set.name}.${key}`),
  );
}

function credentialFromChoice(
  choice: string,
): Record<string, unknown> | undefined {
  if (choice === KEEP_CREDENTIAL) return undefined;
  if (choice === MANAGED_CREDENTIAL) return { mode: "managed" };
  return { mode: "byok", fields: { api_key: choice } };
}

function choiceFromCredential(value: unknown): string {
  return nestedString(value, ["mode"]) === "byok"
    ? KEEP_CREDENTIAL
    : MANAGED_CREDENTIAL;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// JSON merge patch from the loaded agent to the edited one: keys that were
// removed become null. Write-only credentials are never cleared implicitly.
function mergePatch(
  previous: unknown,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = { ...next };
  if (!isRecord(previous)) return patch;
  for (const [key, value] of Object.entries(previous)) {
    if (key === "credential") continue;
    const nextValue = next[key];
    if (!(key in next)) {
      if (value !== null && value !== undefined) patch[key] = null;
    } else if (isRecord(value) && isRecord(nextValue)) {
      patch[key] = mergePatch(value, nextValue);
    }
  }
  return patch;
}

const DEFAULT_VARIABLES = {
  call_outcome: {
    type: "str",
    extract: true,
    description: "One-sentence summary of how the call ended.",
  },
  callback_requested: {
    type: "bool",
    extract: true,
    description: "Did the caller ask to be called back?",
  },
};

export type StudioWorkflowStage = "agents" | "agent" | "phone" | "test" | "campaign";

const selectClass =
  "border-input bg-background ring-offset-background focus-visible:ring-ring flex h-10 w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50";

function alphabetizeProviders<T extends { label: string }>(
  providers: readonly T[],
): T[] {
  return [...providers].sort((left, right) =>
    left.label.localeCompare(right.label),
  );
}

const ASR_VENDORS = alphabetizeProviders([
  { value: "amazon", label: "Amazon Transcribe" },
  { value: "ares", label: "ARES" },
  { value: "assemblyai", label: "AssemblyAI" },
  { value: "deepgram", label: "Deepgram" },
  { value: "google", label: "Google" },
  { value: "microsoft", label: "Microsoft Azure" },
  { value: "openai", label: "OpenAI" },
  { value: "sarvam", label: "Sarvam" },
  { value: "speechmatics", label: "Speechmatics" },
  { value: "xai", label: "xAI" },
]);

const LLM_VENDORS = alphabetizeProviders([
  { value: "amazon", label: "Amazon Bedrock" },
  { value: "azure", label: "Azure OpenAI" },
  { value: "anthropic", label: "Claude · Anthropic" },
  { value: "custom", label: "Custom · OpenAI compatible" },
  { value: "dify", label: "Dify" },
  { value: "gemini", label: "Google Gemini" },
  { value: "google", label: "Google Vertex AI" },
  { value: "groq", label: "Groq" },
  { value: "openai", label: "OpenAI" },
  { value: "xai", label: "xAI · Grok" },
]);

const LLM_STYLES: Record<string, string> = {
  azure: "openai",
  gemini: "gemini",
  google: "gemini",
  anthropic: "anthropic",
  amazon: "bedrock",
  dify: "dify",
  custom: "openai",
};

const TTS_VENDORS = alphabetizeProviders([
  { value: "amazon", label: "Amazon Polly" },
  { value: "cartesia", label: "Cartesia" },
  { value: "deepgram", label: "Deepgram" },
  { value: "elevenlabs", label: "ElevenLabs" },
  { value: "fishaudio", label: "Fish Audio" },
  { value: "google", label: "Google" },
  { value: "humeai", label: "Hume AI" },
  { value: "microsoft", label: "Microsoft Azure" },
  { value: "minimax", label: "MiniMax" },
  { value: "murf", label: "Murf" },
  { value: "openai", label: "OpenAI" },
  { value: "rime", label: "Rime" },
  { value: "sarvam", label: "Sarvam" },
  { value: "xai", label: "xAI" },
]);

const DEFAULT_MINIMAX_PARAMS = {
  voice_setting: {
    voice_id: "English_radiant_girl",
    speed: 1,
  },
  audio_setting: { sample_rate: 44100 },
};

const ACTIVE_CAMPAIGN_STATUSES = new Set(["scheduled", "running", "paused"]);

function campaignsBlockingAgentDeletion(
  campaigns: CampaignSummary[],
  agentId: string,
): CampaignSummary[] {
  return campaigns.filter(
    (campaign) =>
      campaign.agent_id === agentId &&
      ACTIVE_CAMPAIGN_STATUSES.has(campaign.status?.toLowerCase() || ""),
  );
}

function nestedString(value: unknown, path: string[]): string {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return "";
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : "";
}

function nestedRecord(
  value: unknown,
  path: string[],
): Record<string, unknown> {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return {};
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "object" && current !== null
    ? (current as Record<string, unknown>)
    : {};
}

function providerParamsJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}

function parseProviderParams(
  value: string,
  label: string,
): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label} vendor parameters must be a JSON object.`);
  }
}

const CAMPAIGN_WINDOW_HOURS = 12;

// Adds hours to a local "YYYY-MM-DDTHH:MM" value and returns the same format.
function localDateTimePlusHours(value: string, hours: number): string {
  const date = new Date(value);
  date.setHours(date.getHours() + hours);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function AgentStudioPanel({
  stage,
  onStageChange,
  selectedAgentId,
  onAgentChange,
  onAgentNavigate,
  onAgentNameChange,
  selectedPhoneNumberId,
  onPhoneNumberChange,
  testDestination,
  onTestDestinationChange,
  onTestCall,
  testCallLoading,
}: {
  stage: StudioWorkflowStage;
  onStageChange: (stage: StudioWorkflowStage) => void;
  selectedAgentId: string;
  onAgentChange: (agentId: string) => void;
  onAgentNavigate: (
    agentId: string,
    stage: StudioWorkflowStage,
    sectionId?: string,
  ) => void;
  onAgentNameChange?: (agentName: string) => void;
  selectedPhoneNumberId: string;
  onPhoneNumberChange: (numberId: string) => void;
  testDestination: string;
  onTestDestinationChange: (phoneNumber: string) => void;
  onTestCall: (event: FormEvent<HTMLFormElement>) => void;
  testCallLoading: boolean;
}) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const initialRefreshStartedRef = useRef(false);
  const [secretSets, setSecretSets] = useState<SecretSetSummary[]>([]);
  const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumberSummary[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [loadingResources, setLoadingResources] = useState(true);
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [duplicatingAgentId, setDuplicatingAgentId] = useState("");
  const [savingAgent, setSavingAgent] = useState(false);
  const [agentPendingDeletion, setAgentPendingDeletion] =
    useState<AgentSummary | null>(null);
  const [deletingAgent, setDeletingAgent] = useState(false);
  const [deleteAgentError, setDeleteAgentError] = useState<string | null>(null);
  const [deleteAgentConfirmation, setDeleteAgentConfirmation] = useState("");
  const [agentFormDirty, setAgentFormDirty] = useState(false);
  const [agentActionsAtRest, setAgentActionsAtRest] = useState(false);
  const agentActionsAnchorRef = useRef<HTMLDivElement | null>(null);
  // The saved agent as last loaded; updates are sent as a merge patch against it.
  const loadedAgentRef = useRef<Record<string, unknown> | null>(null);
  const [savingCampaign, setSavingCampaign] = useState(false);
  const [campaignActionId, setCampaignActionId] = useState("");
  const [testAgentPickerOpen, setTestAgentPickerOpen] = useState(false);
  const [testPhonePickerOpen, setTestPhonePickerOpen] = useState(false);
  const [createdCampaign, setCreatedCampaign] =
    useState<CampaignConfirmation | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [noticeCollapsed, setNoticeCollapsed] = useState(false);
  const [secretDialog, setSecretDialog] = useState<{
    kind?: ProviderKind;
  } | null>(null);
  const [secretManagerOpen, setSecretManagerOpen] = useState(false);
  const secretDialogReturnToManagerRef = useRef(false);
  const [secretSetName, setSecretSetName] = useState("providers");
  const [secretKeyName, setSecretKeyName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [savingSecret, setSavingSecret] = useState(false);
  const [phoneDialogOpen, setPhoneDialogOpen] = useState(false);
  const [phoneDialogMode, setPhoneDialogMode] = useState<"list" | "add">("list");
  const [phoneDialogStandalone, setPhoneDialogStandalone] = useState(false);
  const [savingPhoneNumber, setSavingPhoneNumber] = useState(false);
  const [phoneRecordName, setPhoneRecordName] = useState("");
  const [phoneRecordNumber, setPhoneRecordNumber] = useState("");
  const [phoneDescription, setPhoneDescription] = useState("");
  const [sipGatewayHost, setSipGatewayHost] = useState("");
  const [sipSignalingPort, setSipSignalingPort] = useState("5060");
  const [sipTransport, setSipTransport] = useState<"udp" | "tcp" | "tls">(
    "udp",
  );

  const [agentName, setAgentName] = useState("Outbound concierge");
  const [systemPrompt, setSystemPrompt] = useState(
    "You are a concise, friendly phone assistant. Keep responses natural and brief.",
  );
  const [greetingMessage, setGreetingMessage] = useState(
    "Hello, this is the Agora voice assistant. Is now a good time to talk?",
  );
  const [variablesJson, setVariablesJson] = useState(
    JSON.stringify(DEFAULT_VARIABLES, null, 2),
  );
  const [asrVendor, setAsrVendor] = useState("ares");
  const [asrLanguage, setAsrLanguage] = useState("en-US");
  const [asrParamsJson, setAsrParamsJson] = useState("{}");
  const [asrProviderValues, setAsrProviderValues] = useState<ProviderConfigValues>(() => defaultProviderValues("asr", "ares"));
  const [llmVendor, setLlmVendor] = useState("openai");
  const [llmProviderValues, setLlmProviderValues] = useState<ProviderConfigValues>(
    () => defaultProviderValues("llm", "openai"),
  );
  const [maxHistory, setMaxHistory] = useState(10);
  const [ttsVendor, setTtsVendor] = useState("minimax");
  const [ttsModel, setTtsModel] = useState("");
  const [ttsParamsJson, setTtsParamsJson] = useState(
    JSON.stringify(DEFAULT_MINIMAX_PARAMS, null, 2),
  );
  const [ttsProviderValues, setTtsProviderValues] = useState<ProviderConfigValues>(() => defaultProviderValues("tts", "minimax"));
  const [asrCredential, setAsrCredential] = useState(MANAGED_CREDENTIAL);
  const [llmCredential, setLlmCredential] = useState("");
  const [ttsCredential, setTtsCredential] = useState("");

  const [campaignName, setCampaignName] = useState("Follow-up campaign");
  const [recipients, setRecipients] = useState("");
  const [startImmediately, setStartImmediately] = useState(true);
  const [scheduledStart, setScheduledStart] = useState("");
  const [timezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const minimumScheduledStart = (() => {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    return now.toISOString().slice(0, 16);
  })();

  const secretOptions = useMemo(() => secretReferences(secretSets), [secretSets]);

  function openSecretDialog(
    kind?: ProviderKind,
    vendor?: string,
    returnToManager = false,
  ) {
    secretDialogReturnToManagerRef.current = returnToManager;
    setSecretDialog({ kind });
    setSecretSetName(secretSets[0]?.name || "providers");
    setSecretKeyName(
      vendor ? `${vendor}_${kind}_key`.replace(/[^A-Za-z0-9_]/g, "_") : "",
    );
    setSecretValue("");
  }

  function closeSecretDialog() {
    const returnToManager = secretDialogReturnToManagerRef.current;
    secretDialogReturnToManagerRef.current = false;
    setSecretDialog(null);
    setSecretValue("");
    if (returnToManager) setSecretManagerOpen(true);
  }

  function resetPhoneForm() {
    setPhoneRecordName("");
    setPhoneRecordNumber("");
    setPhoneDescription("");
    setSipGatewayHost("");
    setSipSignalingPort("5060");
    setSipTransport("udp");
  }

  function closePhoneDialog() {
    setPhoneDialogOpen(false);
    setPhoneDialogMode("list");
    setPhoneDialogStandalone(false);
    resetPhoneForm();
  }

  useEffect(() => {
    if (
      !agentPendingDeletion &&
      !secretDialog &&
      !secretManagerOpen &&
      !phoneDialogOpen
    ) {
      return;
    }

    function closeTopmostOverlay(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (agentPendingDeletion) {
        if (!deletingAgent) {
          setAgentPendingDeletion(null);
          setDeleteAgentError(null);
          setDeleteAgentConfirmation("");
        }
      } else if (secretDialog) {
        const returnToManager = secretDialogReturnToManagerRef.current;
        secretDialogReturnToManagerRef.current = false;
        setSecretDialog(null);
        setSecretValue("");
        if (returnToManager) setSecretManagerOpen(true);
      } else if (phoneDialogOpen) {
        setPhoneDialogOpen(false);
        setPhoneDialogMode("list");
        setPhoneDialogStandalone(false);
        setPhoneRecordName("");
        setPhoneRecordNumber("");
        setPhoneDescription("");
        setSipGatewayHost("");
        setSipSignalingPort("5060");
        setSipTransport("udp");
      } else {
        setSecretManagerOpen(false);
      }
    }

    document.addEventListener("keydown", closeTopmostOverlay);
    return () => document.removeEventListener("keydown", closeTopmostOverlay);
  }, [
    agentPendingDeletion,
    secretDialog,
    secretManagerOpen,
    deletingAgent,
    phoneDialogOpen,
  ]);

  const refreshResources = useCallback(async () => {
    setLoadingResources(true);
    try {
      const [nextAgents, nextSecretSets, nextPhoneNumbers, nextCampaigns] =
        await Promise.all([
          v3ListAll<AgentSummary>("agents"),
          v3ListAll<SecretSetSummary>("secrets"),
          v3ListAll<PhoneNumberSummary>("numbers"),
          v3ListAll<CampaignSummary>("campaigns"),
        ]);
      setAgents(nextAgents.filter((agent) => typeof agent.agent_id === "string"));
      setSecretSets(nextSecretSets.filter((set) => typeof set.name === "string"));
      const usableNumbers = nextPhoneNumbers.filter(
        (phone) => typeof phone.number_id === "string",
      );
      setPhoneNumbers(usableNumbers);
      setCampaigns(nextCampaigns);

      if (!selectedPhoneNumberId && usableNumbers[0]) {
        onPhoneNumberChange(usableNumbers[0].number_id);
      }
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Could not load v3 resources.",
      });
    } finally {
      setLoadingResources(false);
    }
  }, [
    onPhoneNumberChange,
    selectedPhoneNumberId,
  ]);

  useEffect(() => {
    if (initialRefreshStartedRef.current) return;
    initialRefreshStartedRef.current = true;
    void refreshResources();
  }, [refreshResources]);

  useEffect(() => {
    try {
      setAsrProviderValues(providerValuesFromParams("asr", asrVendor, parseProviderParams(asrParamsJson, "ASR")));
    } catch {
      setAsrProviderValues(defaultProviderValues("asr", asrVendor));
    }
  }, [asrParamsJson, asrVendor]);

  useEffect(() => {
    try {
      setTtsProviderValues(providerValuesFromParams("tts", ttsVendor, parseProviderParams(ttsParamsJson, "TTS")));
    } catch {
      setTtsProviderValues(defaultProviderValues("tts", ttsVendor));
    }
  }, [ttsParamsJson, ttsVendor]);

  const resetAgentDetailsState = useCallback((blank = false) => {
    loadedAgentRef.current = null;
    setAgentName(blank ? "" : "Outbound concierge");
    setSystemPrompt(
      blank
        ? ""
        : "You are a concise, friendly phone assistant. Keep responses natural and brief.",
    );
    setGreetingMessage(
      blank
        ? ""
        : "Hello, this is the Agora voice assistant. Is now a good time to talk?",
    );
    setVariablesJson(
      blank ? "{}" : JSON.stringify(DEFAULT_VARIABLES, null, 2),
    );
    setAsrVendor("ares");
    setAsrLanguage("en-US");
    setAsrParamsJson("{}");
    setAsrProviderValues(defaultProviderValues("asr", "ares"));
    setAsrCredential(MANAGED_CREDENTIAL);
    setLlmVendor("openai");
    setLlmProviderValues(defaultProviderValues("llm", "openai"));
    setLlmCredential("");
    setMaxHistory(10);
    setTtsVendor("minimax");
    setTtsModel("");
    setTtsParamsJson(JSON.stringify(DEFAULT_MINIMAX_PARAMS, null, 2));
    setTtsProviderValues(defaultProviderValues("tts", "minimax"));
    setTtsCredential("");
  }, []);

  const applyAgentDetails = useCallback(
    (detail: AgentSummary, name = detail.agent_name || "Outbound concierge") => {
      loadedAgentRef.current = {
        agent_name: detail.agent_name,
        instructions: detail.instructions ?? null,
        greeting: detail.greeting ?? null,
        variables: detail.variables ?? null,
        pipeline: detail.pipeline ?? null,
      };
      setAgentName(name);
      setSystemPrompt(detail.instructions || "");
      setGreetingMessage(detail.greeting?.text || "");
      setVariablesJson(JSON.stringify(detail.variables || {}, null, 2));
      const pipeline = detail.pipeline;
      if (!isRecord(pipeline)) return;

      const asr = nestedRecord(pipeline, ["asr"]);
      setAsrVendor(nestedString(asr, ["vendor"]) || "ares");
      setAsrLanguage(
        nestedString(asr, ["language"]) ||
          nestedString(asr, ["params", "language"]) ||
          "en-US",
      );
      setAsrParamsJson(providerParamsJson(nestedRecord(asr, ["params"])));
      setAsrCredential(choiceFromCredential(asr.credential));

      const llm = nestedRecord(pipeline, ["llm"]);
      const configuredLlmVendor = nestedString(llm, ["vendor"]) || "openai";
      setLlmVendor(configuredLlmVendor);
      setLlmProviderValues(
        providerValuesFromParams("llm", configuredLlmVendor, llm),
      );
      if (typeof llm.max_history === "number") setMaxHistory(llm.max_history);
      setLlmCredential(choiceFromCredential(llm.credential));

      const tts = nestedRecord(pipeline, ["tts"]);
      setTtsVendor(nestedString(tts, ["vendor"]) || "minimax");
      setTtsParamsJson(providerParamsJson(nestedRecord(tts, ["params"])));
      setTtsModel(
        nestedString(tts, ["params", "model"]) ||
          nestedString(tts, ["params", "model_id"]),
      );
      setTtsCredential(choiceFromCredential(tts.credential));
    },
    [],
  );

  useEffect(() => {
    setNotice(null);
  }, [stage]);

  useEffect(() => {
    setNoticeCollapsed(false);
    if (!notice || notice.kind !== "success") return;
    const timeout = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!selectedAgentId) return;
    setNotice(null);
    setCreatingAgent(false);
    setAgentFormDirty(false);
    resetAgentDetailsState(true);
    let cancelled = false;
    void v3Fetch<AgentSummary>(`agents/${encodeURIComponent(selectedAgentId)}`)
      .then((detail) => {
        if (!cancelled) applyAgentDetails(detail);
      })
      .catch((error) => {
        if (!cancelled) {
          setNotice({
            kind: "error",
            message:
              error instanceof Error
                ? error.message
                : "Could not load agent configuration.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [applyAgentDetails, resetAgentDetailsState, selectedAgentId]);

  const activeAgent = useMemo(
    () => agents.find((agent) => agent.agent_id === selectedAgentId),
    [agents, selectedAgentId],
  );
  useEffect(() => {
    onAgentNameChange?.(activeAgent?.agent_name || "");
  }, [activeAgent, onAgentNameChange]);
  const blockingDeletionCampaigns = useMemo(
    () =>
      agentPendingDeletion
        ? campaignsBlockingAgentDeletion(
            campaigns,
            agentPendingDeletion.agent_id,
          )
        : [],
    [agentPendingDeletion, campaigns],
  );
  const activePhone = useMemo(
    () =>
      phoneNumbers.find(
        (phone) => phone.number_id === selectedPhoneNumberId,
      ),
    [phoneNumbers, selectedPhoneNumberId],
  );
  useEffect(() => {
    const anchor = agentActionsAnchorRef.current;
    if (!anchor || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(([entry]) => {
      setAgentActionsAtRest(entry.isIntersecting);
    });
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [stage, selectedAgentId]);

  async function saveSecret(event: FormEvent) {
    event.preventDefault();
    if (!secretDialog) return;
    const setName = secretSetName.trim();
    const keyName = secretKeyName.trim();
    if (!SECRET_NAME_PATTERN.test(setName) || !SECRET_NAME_PATTERN.test(keyName)) {
      setNotice({
        kind: "error",
        message:
          "Secret set and key names must be 1-64 letters, digits, or underscores.",
      });
      return;
    }
    setSavingSecret(true);
    setNotice(null);
    try {
      // Add the key to an existing set, or create the set with this first key.
      if (secretSets.some((set) => set.name === setName)) {
        await v3Fetch(`secrets/${encodeURIComponent(setName)}`, {
          method: "PATCH",
          body: JSON.stringify({ secrets: { [keyName]: secretValue } }),
        });
      } else {
        await v3Fetch("secrets", {
          method: "POST",
          body: JSON.stringify({
            name: setName,
            secrets: { [keyName]: secretValue },
          }),
        });
      }
      const reference = `$secrets.${setName}.${keyName}`;
      if (secretDialog.kind === "asr") setAsrCredential(reference);
      else if (secretDialog.kind === "llm") setLlmCredential(reference);
      else if (secretDialog.kind === "tts") setTtsCredential(reference);
      closeSecretDialog();
      setNotice({
        kind: "success",
        message: secretDialog.kind
          ? `Secret stored and selected as ${reference}.`
          : `Secret stored as ${reference}.`,
      });
      await refreshResources();
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Could not save the secret.",
      });
    } finally {
      setSavingSecret(false);
      setSecretValue("");
    }
  }

  async function savePhoneNumber(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    if (!isValidPhoneNumber(phoneRecordNumber)) {
      setNotice({
        kind: "error",
        message: "Enter a valid source phone number in E.164 format.",
      });
      return;
    }
    const port = sipSignalingPort.trim()
      ? Number(sipSignalingPort)
      : undefined;
    if (port !== undefined && (!Number.isInteger(port) || port <= 0)) {
      setNotice({
        kind: "error",
        message: "SIP signaling port must be a positive integer.",
      });
      return;
    }

    setSavingPhoneNumber(true);
    try {
      const created = await v3Fetch<{ number_id?: unknown }>("numbers", {
        method: "POST",
        body: JSON.stringify({
          number: phoneRecordNumber,
          description: phoneDescription.trim() || null,
          sip_trunk: {
            ...(phoneRecordName.trim() ? { name: phoneRecordName.trim() } : {}),
            hostname: sipGatewayHost.trim(),
            ...(port !== undefined ? { port } : {}),
            transport: sipTransport,
          },
        }),
      });
      if (typeof created?.number_id === "string") {
        onPhoneNumberChange(created.number_id);
      }
      setNotice({
        kind: "success",
        message: "Outbound phone number registered.",
      });
      await refreshResources();
      if (phoneDialogStandalone) {
        resetPhoneForm();
        setPhoneDialogMode("list");
      } else {
        closePhoneDialog();
        onStageChange("test");
      }
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Could not register the phone number.",
      });
    } finally {
      setSavingPhoneNumber(false);
    }
  }

  function buildAgentBody(): Record<string, unknown> {
    const usable = (choice: string) =>
      Boolean(choice) && (choice !== KEEP_CREDENTIAL || Boolean(selectedAgentId));
    if (
      !usable(llmCredential) ||
      (asrVendor !== "ares" && !usable(asrCredential)) ||
      !usable(ttsCredential)
    ) {
      throw new Error(
        "Choose Agora managed or a stored secret for every provider.",
      );
    }

    let variables: unknown;
    try {
      variables = JSON.parse(variablesJson || "{}");
    } catch {
      variables = null;
    }
    if (!isRecord(variables)) {
      throw new Error("Variables must be a JSON object.");
    }

    let asrParams = parseProviderParams(asrParamsJson, "ASR");
    let ttsParams = parseProviderParams(ttsParamsJson, "TTS");
    const documentedAsrParams = buildProviderParams(
      "asr",
      asrVendor,
      asrProviderValues,
      asrLanguage,
    );
    const llmConfig = buildProviderParams(
      "llm",
      llmVendor,
      llmProviderValues,
    );
    const documentedTtsParams = buildProviderParams(
      "tts",
      ttsVendor,
      ttsProviderValues,
    );
    asrParams = {
      ...asrParams,
      ...documentedAsrParams,
      ...(asrVendor === "deepgram" &&
      !("model" in documentedAsrParams)
        ? { model: "nova-3" }
        : {}),
    };
    ttsParams = {
      ...ttsParams,
      ...documentedTtsParams,
      ...(Object.keys(documentedTtsParams).length === 0 && ttsModel.trim()
        ? { model: ttsModel.trim() }
        : {}),
    };

    // v3 LLM input has typed url/model/style/headers/params; vendor extras go in params.
    const llmParams: Record<string, unknown> = isRecord(llmConfig.params)
      ? { ...llmConfig.params }
      : {};
    const llm: Record<string, unknown> = {
      vendor: llmVendor,
      ...(LLM_STYLES[llmVendor] ? { style: LLM_STYLES[llmVendor] } : {}),
      max_history: maxHistory,
      failure_message: "Please hold on a second.",
    };
    for (const [key, value] of Object.entries(llmConfig)) {
      if (key === "params") continue;
      if (key === "url" || key === "model") {
        llm[key] = value;
      } else if (key === "headers") {
        llm.headers = parseProviderParams(String(value), "LLM headers");
      } else {
        llmParams[key] = value;
      }
    }
    if (Object.keys(llmParams).length > 0) llm.params = llmParams;

    const withCredential = (
      config: Record<string, unknown>,
      choice: string,
    ) => {
      const credential = credentialFromChoice(choice);
      return credential ? { ...config, credential } : config;
    };

    const greeting = greetingMessage.trim();
    return {
      agent_name: agentName.trim(),
      instructions: systemPrompt.trim(),
      greeting: greeting ? { mode: "text", text: greeting } : null,
      variables,
      pipeline: {
        mode: "cascaded",
        asr:
          asrVendor === "ares"
            ? {
                vendor: "ares",
                language: asrLanguage.trim(),
                credential: { mode: "managed" },
              }
            : withCredential(
                {
                  vendor: asrVendor,
                  language: asrLanguage.trim(),
                  params: asrParams,
                },
                asrCredential,
              ),
        llm: withCredential(llm, llmCredential),
        tts: withCredential(
          { vendor: ttsVendor, params: ttsParams },
          ttsCredential,
        ),
        turn_detection: {
          start_of_speech: { type: "vad", prefix_padding_ms: 800 },
          end_of_speech: { type: "vad", silence_duration_ms: 480 },
          interruption: { mode: "start_of_speech" },
        },
        silence_config: {
          enabled: true,
          action: "think",
          content: "politely ask if the user is still online",
          timeout_ms: 10000,
        },
      },
    };
  }

  async function saveAgent(event: FormEvent) {
    event.preventDefault();
    setNotice(null);

    if (selectedAgentId) {
      await updateAgent("bottom");
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = buildAgentBody();
    } catch (error) {
      setNotice({
        kind: "error",
        placement: "bottom",
        message:
          error instanceof Error ? error.message : "Invalid provider parameters.",
      });
      return;
    }
    if (body.greeting === null) delete body.greeting;

    setSavingAgent(true);
    try {
      const created = await v3Fetch<{ agent_id?: unknown }>("agents", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const agentId =
        typeof created?.agent_id === "string" ? created.agent_id : "";
      if (!agentId) throw new Error("The API did not return an agent_id.");
      onAgentChange(agentId);
      setCreatingAgent(false);
      setNotice({
        kind: "success",
        placement: "bottom",
        message: "Agent saved and ready to use.",
      });
      await refreshResources();
    } catch (error) {
      setNotice({
        kind: "error",
        placement: "bottom",
        message: error instanceof Error ? error.message : "Could not create agent.",
      });
    } finally {
      setSavingAgent(false);
    }
  }

  async function updateAgent(placement: "top" | "bottom" = "top") {
    if (!selectedAgentId) return;
    setSavingAgent(true);
    setNotice(null);
    try {
      const patch = mergePatch(loadedAgentRef.current, buildAgentBody());
      const updated = await v3Fetch<AgentSummary>(
        `agents/${encodeURIComponent(selectedAgentId)}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      );
      if (updated && typeof updated.agent_id === "string") {
        applyAgentDetails(updated);
      }
      setAgentFormDirty(false);
      setNotice({
        kind: "success",
        placement,
        message: "Agent updated successfully.",
      });
      await refreshResources();
    } catch (error) {
      setNotice({
        kind: "error",
        placement,
        message:
          error instanceof Error ? error.message : "Could not update agent.",
      });
    } finally {
      setSavingAgent(false);
    }
  }

  function requestAgentDeletion(agent: AgentSummary) {
    setDeleteAgentError(null);
    setDeleteAgentConfirmation("");
    setAgentPendingDeletion(agent);
  }

  function closeAgentDeletion() {
    if (deletingAgent) return;
    setAgentPendingDeletion(null);
    setDeleteAgentError(null);
    setDeleteAgentConfirmation("");
  }

  async function deletePendingAgent() {
    if (
      !agentPendingDeletion ||
      deletingAgent ||
      deleteAgentConfirmation !== "delete"
    ) {
      return;
    }

    setDeletingAgent(true);
    setDeleteAgentError(null);
    try {
      const latestCampaigns = await v3ListAll<CampaignSummary>("campaigns");
      setCampaigns(latestCampaigns);
      const blockingCampaigns = campaignsBlockingAgentDeletion(
        latestCampaigns,
        agentPendingDeletion.agent_id,
      );
      if (blockingCampaigns.length > 0) {
        return;
      }

      await v3Fetch(
        `agents/${encodeURIComponent(agentPendingDeletion.agent_id)}`,
        { method: "DELETE" },
      );

      const deletedAgent = agentPendingDeletion;
      const deletedSelectedAgent =
        deletedAgent.agent_id === selectedAgentId;
      setAgents((current) =>
        current.filter((agent) => agent.agent_id !== deletedAgent.agent_id),
      );
      setAgentPendingDeletion(null);
      setDeleteAgentError(null);
      setDeleteAgentConfirmation("");

      const message = `${deletedAgent.agent_name || "Agent"} was deleted.`;
      if (deletedSelectedAgent) {
        onAgentChange("");
        setCreatingAgent(false);
        setAgentFormDirty(false);
        resetAgentDetailsState();
        onStageChange("agents");
        window.setTimeout(() => {
          setNotice({ kind: "success", message });
        }, 0);
      } else {
        setNotice({ kind: "success", message });
      }
    } catch (error) {
      setDeleteAgentError(
        error instanceof Error ? error.message : "Could not delete the agent.",
      );
    } finally {
      setDeletingAgent(false);
    }
  }

  async function importCampaignCsv(file: File) {
    setNotice(null);
    try {
      const contents = await file.text();
      const contacts = campaignContactsFromText(contents);
      if (contacts.length === 0) {
        throw new Error("The CSV does not contain any recipients.");
      }
      setRecipients(contents.trim());
      setNotice({
        kind: "success",
        message: `${contacts.length} recipient${contacts.length === 1 ? "" : "s"} imported from ${file.name}.`,
      });
    } catch (error) {
      setNotice({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not import the CSV.",
      });
    }
  }

  async function createCampaign(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    setCreatedCampaign(null);
    let contacts: CampaignContact[];
    try {
      contacts = campaignContactsFromText(recipients);
    } catch (error) {
      setNotice({
        kind: "error",
        message: error instanceof Error ? error.message : "Invalid campaign recipients.",
      });
      return;
    }
    if (!selectedAgentId || !selectedPhoneNumberId || contacts.length === 0) {
      setNotice({
        kind: "error",
        message: "Select an agent and source number, then add at least one recipient.",
      });
      return;
    }
    if (!startImmediately) {
      const scheduledDate = new Date(scheduledStart);
      if (
        !scheduledStart ||
        Number.isNaN(scheduledDate.getTime()) ||
        scheduledDate.getTime() <= Date.now()
      ) {
        setNotice({
          kind: "error",
          message: "Choose a scheduled start date and time in the future.",
        });
        return;
      }
    }

    setSavingCampaign(true);
    try {
      const created = await v3Fetch<Partial<CampaignSummary>>("campaigns", {
        method: "POST",
        body: JSON.stringify({
          name: campaignName.trim(),
          agent_id: selectedAgentId,
          transport: { type: "telephony", from: selectedPhoneNumberId },
          contacts,
          schedule: startImmediately
            ? { mode: "immediate" }
            : {
                mode: "scheduled",
                timezone: timezone.trim() || "UTC",
                start: scheduledStart.slice(0, 16),
                end: localDateTimePlusHours(scheduledStart, CAMPAIGN_WINDOW_HOURS),
              },
        }),
      });
      setCreatedCampaign({
        campaignId:
          typeof created?.campaign_id === "string"
            ? created.campaign_id
            : undefined,
        campaignName: campaignName.trim(),
        recipientCount: contacts.length,
        startImmediately,
        scheduledStart: startImmediately
          ? undefined
          : new Date(scheduledStart).toISOString(),
        timezone: timezone.trim() || "UTC",
      });
      setNotice({ kind: "success", message: "Campaign created." });
      setRecipients("");
      await refreshResources();
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Could not create campaign.",
      });
    } finally {
      setSavingCampaign(false);
    }
  }

  async function runCampaignAction(
    campaign: CampaignSummary,
    action: "pause" | "resume" | "cancel",
  ) {
    setNotice(null);
    setCampaignActionId(campaign.campaign_id);
    try {
      await v3Fetch(
        `campaigns/${encodeURIComponent(campaign.campaign_id)}/${action}`,
        { method: "POST" },
      );
      setNotice({
        kind: "success",
        message: `${campaign.name || "Campaign"} ${action === "cancel" ? "canceled" : `${action}d`}.`,
      });
      await refreshResources();
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error ? error.message : `Could not ${action} the campaign.`,
      });
    } finally {
      setCampaignActionId("");
    }
  }

  function startNewAgent() {
    onAgentChange("");
    setNotice(null);
    setAgentFormDirty(false);
    resetAgentDetailsState();
    setCreatingAgent(true);
    onStageChange("agent");
    window.setTimeout(() => {
      document
        .getElementById("agent-setup-details")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }

  async function startAgentFromTemplate(agent: AgentSummary) {
    setNotice(null);
    setDuplicatingAgentId(agent.agent_id);
    try {
      const detail = await v3Fetch<AgentSummary>(
        `agents/${encodeURIComponent(agent.agent_id)}`,
      );
      resetAgentDetailsState(true);
      applyAgentDetails(
        detail,
        `${detail.agent_name || agent.agent_name || "Agent"} copy`,
      );
      // A copy is a new agent: write-only BYOK credentials must be chosen again.
      loadedAgentRef.current = null;
      const reselect = (choice: string) =>
        choice === KEEP_CREDENTIAL ? "" : choice;
      setAsrCredential(reselect);
      setLlmCredential(reselect);
      setTtsCredential(reselect);
      onAgentChange("");
      setAgentFormDirty(false);
      setCreatingAgent(true);
      onStageChange("agent");
      window.setTimeout(() => {
        document
          .getElementById("agent-setup-details")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 0);
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Could not load the agent template.",
      });
    } finally {
      setDuplicatingAgentId("");
    }
  }

  function renderSelectedCallResources() {
    return (
      <div className="grid gap-3 text-left sm:grid-cols-2">
        <div className="rounded-xl border border-border bg-muted/15 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
                <Bot className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">Selected agent</p>
                <p className="truncate text-sm font-semibold">{activeAgent?.agent_name || "Saved agent"}</p>
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              <Badge variant="outline" className="border-muted/60 bg-muted/40 text-muted-foreground">
                Live
              </Badge>
              <Button type="button" variant="ghost" size="sm" onClick={() => onStageChange("agents")}>
                Change
              </Button>
            </div>
          </div>
          <p className="text-muted-foreground mt-3 truncate font-mono text-[11px]" title={selectedAgentId}>
            Agent ID: {selectedAgentId}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-muted/15 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
                <Phone className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide">Calling from</p>
                <p className="truncate text-sm font-semibold">{activePhone?.number || activePhone?.sip_trunk?.name || "Stored source number"}</p>
              </div>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => onStageChange("phone")}>
              Change
            </Button>
          </div>
          <p className="text-muted-foreground mt-3 truncate font-mono text-[11px]" title={selectedPhoneNumberId}>
            Phone number ID: {selectedPhoneNumberId}
          </p>
        </div>
      </div>
    );
  }

  function renderCampaignHistory() {
    const agentCampaigns = selectedAgentId
      ? campaigns.filter((campaign) => campaign.agent_id === selectedAgentId)
      : campaigns;
    const activeCampaigns = agentCampaigns.filter((campaign) =>
      ACTIVE_CAMPAIGN_STATUSES.has(campaign.status?.toLowerCase() || ""),
    );
    const pastCampaigns = agentCampaigns.filter(
      (campaign) =>
        !ACTIVE_CAMPAIGN_STATUSES.has(campaign.status?.toLowerCase() || ""),
    );

    const renderGroup = (
      title: string,
      description: string,
      items: CampaignSummary[],
    ) => (
      <div className="space-y-3">
        <div>
          <h4 className="text-sm font-semibold">{title}</h4>
          <p className="text-muted-foreground mt-1 text-xs">{description}</p>
        </div>
        {items.length === 0 ? (
          <div className="text-muted-foreground rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm">
            No {title.toLowerCase()}.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border">
            {items.map((campaign) => {
              const status = campaign.status?.toLowerCase() || "unknown";
              const counts = campaign.counts;
              const finished =
                (counts?.completed || 0) +
                (counts?.failed || 0) +
                (counts?.canceled || 0);
              const activityAt =
                campaign.complete_ts ?? campaign.start_ts ?? campaign.create_ts;
              const sourceNumberId = Array.isArray(campaign.transport?.from)
                ? campaign.transport?.from.join(", ")
                : campaign.transport?.from;
              const busy = campaignActionId === campaign.campaign_id;
              return (
                <article
                  key={campaign.campaign_id}
                  className="border-b border-border bg-muted/10 p-5 last:border-b-0"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">
                        {campaign.name || "Unnamed campaign"}
                      </p>
                      <p className="text-muted-foreground mt-1 break-all font-mono text-xs">
                        {campaign.campaign_id}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <Badge
                        variant="outline"
                        className={cn(
                          "capitalize",
                          status === "running" &&
                            "border-accent/35 text-accent",
                          status === "scheduled" &&
                            "border-accent/35 text-accent",
                          status === "failed" &&
                            "border-red-400/35 text-red-200",
                          (status === "paused" || status === "canceled") &&
                            "border-amber-500/35 bg-amber-500/8 text-amber-700",
                        )}
                      >
                        {status.replaceAll("_", " ")}
                      </Badge>
                      {(status === "scheduled" || status === "running") && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => void runCampaignAction(campaign, "pause")}
                        >
                          Pause
                        </Button>
                      )}
                      {status === "paused" && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => void runCampaignAction(campaign, "resume")}
                        >
                          Resume
                        </Button>
                      )}
                      {ACTIVE_CAMPAIGN_STATUSES.has(status) && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          disabled={busy}
                          onClick={() => void runCampaignAction(campaign, "cancel")}
                        >
                          {busy ? <Loader2 className="animate-spin" /> : null}
                          Cancel
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="text-muted-foreground mt-4 grid gap-3 text-xs sm:grid-cols-4">
                    <div>
                      <span className="block uppercase tracking-wider">Progress</span>
                      <span className="text-foreground mt-1 block">
                        {typeof counts?.contacts === "number"
                          ? `${finished} of ${counts.contacts} contacts`
                          : "Not returned"}
                      </span>
                    </div>
                    <div>
                      <span className="block uppercase tracking-wider">Agent</span>
                      <span className="text-foreground mt-1 block truncate font-mono" title={campaign.agent_id}>
                        {campaign.agent_id || "Not returned"}
                      </span>
                    </div>
                    <div>
                      <span className="block uppercase tracking-wider">Source number ID</span>
                      <span className="text-foreground mt-1 block font-mono">
                        {sourceNumberId || "Not returned"}
                      </span>
                    </div>
                    <div>
                      <span className="block uppercase tracking-wider">Last activity</span>
                      <span className="text-foreground mt-1 block">
                        {formatTimestamp(activityAt)}
                      </span>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    );

    return (
      <section
        id="campaign-activity"
        className="scroll-mt-6 space-y-6 border-t border-border pt-8"
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold">Campaign activity</h3>
            <p className="text-muted-foreground mt-1 text-sm">
              Active and past campaigns for the selected agent.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void refreshResources()}
            disabled={loadingResources}
          >
            {loadingResources ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            Refresh
          </Button>
        </div>
        {loadingResources && campaigns.length === 0 ? (
          <div className="text-muted-foreground flex min-h-28 items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm">
            <Loader2 className="size-4 animate-spin" /> Loading campaigns
          </div>
        ) : (
          <div className="grid gap-7 lg:grid-cols-2">
            {renderGroup(
              "Active campaigns",
              "Scheduled, running, and paused campaigns.",
              activeCampaigns,
            )}
            {renderGroup(
              "Past campaigns",
              "Completed, canceled, and failed campaigns.",
              pastCampaigns,
            )}
          </div>
        )}
      </section>
    );
  }

  return (
    <>
    <Card className="mb-10 overflow-visible border-border bg-card/85 shadow-sm">
      <CardHeader className="border-border/80 border-b py-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-xl">
                {stage === "agents" || stage === "agent"
                  ? "Agent setup"
                  : stage === "phone"
                    ? "Phone number"
                    : stage === "test"
                      ? "Test call"
                      : "Campaigns"}
              </CardTitle>
              {stage === "agent" && (selectedAgentId || creatingAgent) && (
                <Badge
                  variant={selectedAgentId ? "default" : "outline"}
                  className={selectedAgentId ? "border-accent/35 bg-accent/12 text-accent" : "border-muted/60 bg-muted/40 text-muted-foreground"}
                >
                  {selectedAgentId ? "Live" : "New"}
                </Badge>
              )}
              {(stage === "phone" ||
                stage === "test" ||
                stage === "campaign") && (
                <Badge variant="outline" className="capitalize">
                  {stage === "phone" ? "Phone number" : stage.replaceAll("_", " ")}
                </Badge>
              )}
            </div>
            <CardDescription>
              {stage === "agent" && (selectedAgentId || creatingAgent)
                ? "Create or update the saved v3 agent configuration."
                : stage === "phone"
                  ? "Select a registered source number, or register an existing SIP-capable number you control. The v3 API uses its number ID for test calls and campaigns."
                  : stage === "test"
                    ? "Enter your phone number or any destination you are authorized to call. The live agent calls it from the selected source number."
                    : stage === "campaign"
                      ? "Configure and review outbound campaigns for this agent."
                      : "Choose an existing agent to edit, or start a new configuration."}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {stage === "campaign" &&
              selectedAgentId && (
                <div className="w-full space-y-1 sm:w-80">
                  <Label
                    htmlFor="headerAgentSelector"
                    className="text-muted-foreground block text-[10px] font-medium uppercase tracking-wider"
                  >
                    Current agent
                  </Label>
                  <select
                    id="headerAgentSelector"
                    value={selectedAgentId}
                    onChange={(event) =>
                      onAgentNavigate(event.target.value, stage)
                    }
                    className={cn(selectClass, "h-9 cursor-pointer")}
                  >
                    {agents.map((agent) => (
                      <option key={agent.agent_id} value={agent.agent_id}>
                        {agent.agent_name || "Unnamed agent"}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            {stage === "campaign" && selectedAgentId && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="order-first cursor-pointer self-end"
                onClick={() => {
                  const sectionId = "campaign-activity";
                  const url = new URL(window.location.href);
                  url.hash = sectionId;
                  window.history.replaceState(window.history.state, "", url);
                  document.getElementById(sectionId)?.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                  });
                }}
              >
                <CalendarClock /> Campaign activity
              </Button>
            )}
            {stage === "agent" && (selectedAgentId || creatingAgent) && (
              <Button
                type="button"
                variant="outline"
                className="cursor-pointer border-accent/45 bg-accent/10 text-accent hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  onAgentChange("");
                  setCreatingAgent(false);
                  onStageChange("agents");
                }}
              >
                View all agents
              </Button>
            )}
            {stage === "agents" && (
              <Button
                type="button"
                variant="outline"
                className="cursor-pointer"
                onClick={() => setSecretManagerOpen(true)}
              >
                <KeyRound /> Manage secrets
              </Button>
            )}
            {stage === "agents" && (
              <Button
                type="button"
                variant="outline"
                className="cursor-pointer"
                onClick={() => {
                  setPhoneDialogStandalone(true);
                  setPhoneDialogMode("list");
                  setPhoneDialogOpen(true);
                }}
              >
                <Phone /> Manage phone numbers
              </Button>
            )}
            {stage === "agents" && (
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="cursor-pointer"
                aria-label="Refresh agents"
                onClick={() => void refreshResources()}
                disabled={loadingResources}
              >
                {loadingResources ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-6">
        {stage !== "agents" && (selectedAgentId || creatingAgent) && (
        <div className="mb-8 grid gap-2 rounded-xl border border-border bg-muted/20 p-2 sm:grid-cols-4">
          {(
            [
              { id: "agent", label: "Agent setup", icon: Settings2 },
              { id: "phone", label: "Phone number", icon: Phone },
              { id: "test", label: "Test call", icon: Bot },
              { id: "campaign", label: "Campaign", icon: Megaphone },
            ] as const
          ).map((item, index) => {
            const Icon = item.icon;
            const disabled =
              (item.id === "test" || item.id === "campaign") &&
              (!selectedAgentId || !selectedPhoneNumberId);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onStageChange(item.id)}
                disabled={disabled}
                className={cn(
                  "group flex min-h-16 items-center gap-3 rounded-lg px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-40",
                  stage === item.id
                    ? "bg-background text-foreground shadow-lg shadow-black/20"
                    : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition",
                      stage === item.id
                      ? "border-accent/50 bg-accent/10 text-accent"
                      : "border-border bg-muted/50",
                  )}
                >
                  {stage === item.id ? <Icon className="size-3.5" /> : index + 1}
                </span>
                <span>
                  <span className="block text-[10px] font-medium tracking-wider uppercase opacity-60">
                    Step {index + 1}
                  </span>
                  <span className="block text-sm font-medium">{item.label}</span>
                </span>
              </button>
            );
          })}
        </div>
        )}

        {notice && (
          <div className="fixed right-4 bottom-4 z-[70] w-[min(calc(100vw-2rem),28rem)]">
            <Alert
              role={notice.kind === "success" ? "status" : "alert"}
              variant={notice.kind === "error" ? "destructive" : "default"}
              className={cn(
                "relative pr-24 shadow-2xl shadow-black/30 backdrop-blur",
                notice.kind === "warning" &&
                  "border-amber-500/40 bg-amber-500/10 text-amber-600",
              )}
            >
              {notice.kind === "success" ? <Check /> : <Settings2 />}
              <AlertTitle>
                {notice.kind === "success"
                  ? "Saved"
                  : notice.kind === "warning"
                    ? "Warning"
                    : "Request failed"}
              </AlertTitle>
              {!noticeCollapsed && (
                <AlertDescription>{notice.message}</AlertDescription>
              )}
              <div className="absolute top-2 right-2 flex items-center gap-1">
                {notice.kind !== "success" && (
                  <button
                    type="button"
                    className="cursor-pointer rounded-md px-2 py-1 text-[11px] font-medium hover:bg-current/10"
                    onClick={() => setNoticeCollapsed((current) => !current)}
                  >
                    {noticeCollapsed ? "Expand" : "Collapse"}
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Close notification"
                  className="cursor-pointer rounded-md p-1 hover:bg-current/10"
                  onClick={() => setNotice(null)}
                >
                  <X className="size-4" />
                </button>
              </div>
            </Alert>
          </div>
        )}

        {stage === "agent" && (selectedAgentId || creatingAgent) ? (
          <form
            id="agent-setup-details"
            onSubmit={saveAgent}
            onChangeCapture={() => setAgentFormDirty(true)}
            className="scroll-mt-6 space-y-7"
          >
            <div className="space-y-2 md:max-w-md">
              <Label htmlFor="agentName">Agent name</Label>
              <Input id="agentName" value={agentName} onChange={(e) => setAgentName(e.target.value)} required />
            </div>

            <div className="grid gap-4 rounded-xl border border-border bg-muted/15 p-4 lg:grid-cols-2">
              <div className="space-y-2 lg:col-span-2">
                <Label htmlFor="studioSystemPrompt">Instructions</Label>
                <Textarea
                  id="studioSystemPrompt"
                  className="min-h-28"
                  value={systemPrompt}
                  onChange={(event) => setSystemPrompt(event.target.value)}
                  required
                />
                <p className="text-muted-foreground text-xs leading-relaxed">
                  Use {"{{}}"} for dynamic variables.
                  <br />
                  Example: {"{{customer_name}}"}. Declare each variable below;
                  campaign CSV columns supply its value per contact.
                </p>
              </div>
              <div className="space-y-2 lg:col-span-2">
                <Label htmlFor="agentVariables">Variables (JSON)</Label>
                <Textarea
                  id="agentVariables"
                  className="min-h-32 font-mono text-xs"
                  value={variablesJson}
                  onChange={(event) => setVariablesJson(event.target.value)}
                  spellCheck={false}
                />
                <p className="text-muted-foreground text-xs leading-relaxed">
                  Map of name to {"{ type, description, extract, required }"}.
                  Variables with <code>extract: true</code> are filled after each
                  call and shown as the session analysis.
                </p>
              </div>
              <div className="space-y-2 lg:col-span-2">
                <Label htmlFor="studioGreeting">First spoken message</Label>
                <Textarea
                  id="studioGreeting"
                  value={greetingMessage}
                  onChange={(event) => setGreetingMessage(event.target.value)}
                />
              </div>
            </div>

            <div className="rounded-xl border border-border bg-muted/15 p-4">
              <div className="mb-4 flex items-center gap-2">
                <KeyRound className="size-4 text-accent" />
                <div>
                  <p className="text-sm font-medium">Provider setup</p>
                  <p className="text-muted-foreground text-xs">
                    Use Agora managed credentials or a stored secret reference for each provider. ARES always uses managed credentials.
                  </p>
                </div>
              </div>
              <div className="space-y-4">
                {(["asr", "llm", "tts"] as const).map((type) => {
                  const value =
                    type === "asr"
                      ? asrCredential
                      : type === "llm"
                        ? llmCredential
                        : ttsCredential;
                  const setter =
                    type === "asr"
                      ? setAsrCredential
                      : type === "llm"
                        ? setLlmCredential
                        : setTtsCredential;
                  const vendor =
                    type === "asr"
                      ? asrVendor
                      : type === "tts"
                        ? ttsVendor
                        : llmVendor;
                  const providerControl =
                    type === "llm" ? (
                      <div className="flex items-center gap-3 border-b border-border/70 pb-4">
                        <Label htmlFor="llmModuleVendor" className="w-10 shrink-0 font-semibold">LLM</Label>
                        <select
                          id="llmModuleVendor"
                          className={`${selectClass} max-w-xs`}
                          value={llmVendor}
                          onChange={(event) => {
                            const nextVendor = event.target.value;
                            setLlmVendor(nextVendor);
                            setLlmCredential("");
                            setLlmProviderValues(defaultProviderValues("llm", nextVendor));
                          }}
                        >
                          {LLM_VENDORS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : type === "asr" ? (
                      <div className="flex items-center gap-3 border-b border-border/70 pb-4">
                        <Label htmlFor="asrModuleVendor" className="w-10 shrink-0 font-semibold">ASR</Label>
                        <select
                          id="asrModuleVendor"
                          className={`${selectClass} max-w-xs`}
                          value={asrVendor}
                          onChange={(event) => {
                            const nextVendor = event.target.value;
                            setAsrVendor(nextVendor);
                            setAsrCredential(nextVendor === "ares" ? MANAGED_CREDENTIAL : "");
                            setAsrParamsJson("{}");
                            setAsrProviderValues(defaultProviderValues("asr", nextVendor));
                          }}
                        >
                          {ASR_VENDORS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3 border-b border-border/70 pb-4">
                        <Label htmlFor="ttsModuleVendor" className="w-10 shrink-0 font-semibold">TTS</Label>
                        <select
                          id="ttsModuleVendor"
                          className={`${selectClass} max-w-xs`}
                          value={ttsVendor}
                          onChange={(event) => {
                            const nextVendor = event.target.value;
                            setTtsVendor(nextVendor);
                            setTtsCredential("");
                            setTtsModel("");
                            setTtsProviderValues(defaultProviderValues("tts", nextVendor));
                            setTtsParamsJson(
                              nextVendor === "minimax"
                                ? JSON.stringify(DEFAULT_MINIMAX_PARAMS, null, 2)
                                : "{}",
                            );
                          }}
                        >
                          {TTS_VENDORS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  const maxHistoryControl = (
                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5">
                        <Label htmlFor="llmMaxHistory">Max history</Label>
                        <button
                          type="button"
                          className="group relative flex size-4 items-center justify-center rounded-full border border-border text-[10px] font-semibold text-muted-foreground"
                          aria-label="About max history"
                        >
                          ?
                          <span
                            role="tooltip"
                            className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-64 -translate-x-1/2 rounded-md bg-foreground px-3 py-2 text-left text-xs font-normal text-background opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                          >
                            Maximum number of conversation messages retained for LLM context.
                          </span>
                        </button>
                      </div>
                      <Input
                        id="llmMaxHistory"
                        type="number"
                        min={1}
                        step={1}
                        value={maxHistory}
                        onChange={(event) =>
                          setMaxHistory(
                            Math.max(1, Number.parseInt(event.target.value, 10) || 1),
                          )
                        }
                      />
                    </div>
                  );
                  const moduleControl =
                    type === "asr" ? (
                      asrVendor === "ares" ? (
                        <div className="max-w-sm space-y-2">
                          <Label htmlFor="asrLanguage">Language</Label>
                          <Input
                            id="asrLanguage"
                            value={asrLanguage}
                            onChange={(event) => setAsrLanguage(event.target.value)}
                            placeholder="en-US"
                            required
                          />
                        </div>
                      ) : (
                        <div className="space-y-4">
                          <div className="grid gap-4 sm:grid-cols-2">
                            <ProviderConfigFields
                              kind="asr"
                              vendor={asrVendor}
                              values={asrProviderValues}
                              onChange={setAsrProviderValues}
                              section="model"
                              emptyLabel="Provider default"
                            />
                            <div className="space-y-2">
                              <Label htmlFor="asrLanguage">Language</Label>
                              <Input id="asrLanguage" value={asrLanguage} onChange={(event) => setAsrLanguage(event.target.value)} placeholder="en-US" required />
                            </div>
                          </div>
                          <div className="grid gap-4 border-t border-border/70 pt-4">
                            <ProviderConfigFields
                              kind="asr"
                              vendor={asrVendor}
                              values={asrProviderValues}
                              onChange={setAsrProviderValues}
                              section="settings"
                            />
                          </div>
                        </div>
                      )
                    ) : type === "llm" ? (
                      <ProviderConfigFields
                        kind="llm"
                        vendor={llmVendor}
                        values={llmProviderValues}
                        onChange={setLlmProviderValues}
                        afterModelField={maxHistoryControl}
                      />
                    ) : (
                      <div className="space-y-4">
                        <ProviderConfigFields kind="tts" vendor={ttsVendor} values={ttsProviderValues} onChange={setTtsProviderValues} />
                      </div>
                    );
                  return (
                    <div
                      className="space-y-4 rounded-xl border border-border bg-background/35 p-4"
                      key={type}
                    >
                      {providerControl}
                      {moduleControl}
                      {!(type === "asr" && asrVendor === "ares") && (
                      <div className="space-y-3 border-t border-border pt-3">
                        <Label htmlFor={`${type}Credential`}>Credential</Label>
                        <select
                          id={`${type}Credential`}
                          className={selectClass}
                          value={value}
                          onChange={(event) => setter(event.target.value)}
                          required
                        >
                          <option value="">Select a credential</option>
                          {value === KEEP_CREDENTIAL && (
                            <option value={KEEP_CREDENTIAL}>
                              Keep the saved BYOK credential
                            </option>
                          )}
                          <option value={MANAGED_CREDENTIAL}>Agora managed</option>
                          {secretOptions.map((reference) => (
                            <option key={reference} value={reference}>
                              {reference}
                            </option>
                          ))}
                        </select>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => openSecretDialog(type, vendor)}
                        >
                          <KeyRound /> Store a {vendor} key as a secret
                        </Button>
                        <p className="text-muted-foreground text-xs">
                          Secret references are sent as{" "}
                          <code>credential.fields.api_key</code>. Saved
                          credentials are write-only, so the editor shows
                          &ldquo;keep&rdquo; until you choose a new one.
                        </p>
                      </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div ref={agentActionsAnchorRef} className="h-px" aria-hidden="true" />
            <div
              className={cn(
                "flex w-full flex-wrap items-center justify-between gap-3",
                (!selectedAgentId || agentFormDirty || savingAgent) &&
                  "sticky bottom-3 z-20",
              )}
            >
              {selectedAgentId && (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={savingAgent}
                  onClick={() =>
                    requestAgentDeletion(
                      activeAgent || {
                        agent_id: selectedAgentId,
                        agent_name: agentName,
                      },
                    )
                  }
                >
                  <Trash2 /> Delete agent
                </Button>
              )}
              <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
                {selectedAgentId && (!agentFormDirty || agentActionsAtRest) && (
                  <div
                    className={cn(
                      "flex flex-wrap items-center justify-end gap-3",
                      agentFormDirty &&
                        "animate-in fade-in slide-in-from-bottom-2 duration-300",
                    )}
                  >
                    <Button asChild type="button" variant="outline">
                      <a
                        href={
                          phoneNumbers.length > 0
                            ? `/studio/test/${selectedAgentId}`
                            : `/studio/phone/${selectedAgentId}`
                        }
                      >
                        {phoneNumbers.length > 0
                          ? "Continue to test call"
                          : "Continue to phone setup"}
                      </a>
                    </Button>
                    {phoneNumbers.length > 0 && (
                      <Button asChild type="button" variant="outline">
                        <a href={`/studio/campaign/${selectedAgentId}`}>
                          Test campaign
                        </a>
                      </Button>
                    )}
                  </div>
                )}
                {selectedAgentId && !agentFormDirty && !savingAgent ? (
                  <Button type="submit" size="lg" disabled>
                    <Rocket /> Update agent
                  </Button>
                ) : (
                  <div
                    className={cn(
                      "flex flex-wrap items-center justify-end gap-3 rounded-xl border border-border bg-background/95 p-3 shadow-[0_-16px_32px_-24px_rgba(0,0,0,0.8)] backdrop-blur",
                      selectedAgentId &&
                        "animate-in fade-in slide-in-from-bottom-4 duration-300",
                    )}
                  >
                    <p className="text-muted-foreground text-right text-xs">
                      {!selectedAgentId
                        ? "Saves this configuration as a v3 agent."
                        : "You have unsaved agent changes."}
                    </p>
                    <Button type="submit" size="lg" disabled={savingAgent || loadingResources}>
                      {savingAgent ? <Loader2 className="animate-spin" /> : selectedAgentId ? <Rocket /> : <Bot />}
                      {savingAgent
                        ? selectedAgentId
                          ? "Updating…"
                          : "Creating…"
                        : selectedAgentId
                          ? "Update agent"
                          : "Create agent"}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </form>
        ) : stage === "agents" || stage === "agent" ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold">Your agents</h3>
                <p className="text-muted-foreground mt-1 text-sm">
                  Select an agent to open its current configuration in the editor.
                </p>
              </div>
              <Badge variant="outline">
                {agents.length} agent{agents.length === 1 ? "" : "s"}
              </Badge>
            </div>

            {loadingResources ? (
              <div className="text-muted-foreground flex min-h-40 items-center justify-center gap-2 rounded-xl border border-dashed border-border">
                <Loader2 className="animate-spin" /> Loading agents
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                <button
                  type="button"
                  className="text-muted-foreground flex min-h-32 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border p-5 text-center transition hover:border-accent/45 hover:bg-accent/10 hover:text-foreground"
                  onClick={startNewAgent}
                >
                  <span className="flex size-10 items-center justify-center rounded-full border border-accent/30 bg-accent/10 text-accent">
                    <Bot className="size-4" />
                  </span>
                  <span className="font-medium">
                    {agents.length === 0 ? "Create your first agent" : "Create a new agent"}
                  </span>
                </button>

                {agents.map((agent) => {
                  return (
                  <div
                    key={agent.agent_id}
                    className="group flex min-h-32 flex-col overflow-hidden rounded-xl border border-border bg-muted/15 transition hover:border-accent/45 hover:bg-accent/10 hover:shadow-lg hover:shadow-accent/15"
                  >
                    <button
                      type="button"
                      className="flex flex-1 cursor-pointer flex-col justify-between p-5 text-left"
                      onClick={() => {
                        setCreatingAgent(false);
                        onAgentNavigate(agent.agent_id, "agent");
                      }}
                    >
                    <span className="flex w-full items-start justify-between gap-4">
                      <span className="text-base font-semibold transition group-hover:text-accent">
                        {agent.agent_name || "Unnamed agent"}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Badge className="border-accent/35 bg-accent/12 text-accent">
                          Live
                        </Badge>
                        <Settings2 className="text-muted-foreground size-4 transition group-hover:text-accent" />
                      </span>
                    </span>
                    <span className="text-muted-foreground font-mono text-xs">
                      {agent.agent_id}
                    </span>
                    </button>
                    <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
                      <button
                        type="button"
                        className="text-accent hover:bg-accent/12 hover:text-accent inline-flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition hover:-translate-y-0.5 disabled:cursor-wait disabled:opacity-60 disabled:hover:translate-y-0"
                        disabled={Boolean(duplicatingAgentId)}
                        onClick={() => void startAgentFromTemplate(agent)}
                      >
                        {duplicatingAgentId === agent.agent_id ? (
                          <Loader2 className="size-3.5 animate-spin" aria-hidden />
                        ) : (
                          <Copy className="size-3.5" aria-hidden />
                        )}
                        Duplicate
                      </button>
                      <button
                        type="button"
                        className="inline-flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium text-violet-600 transition hover:-translate-y-0.5 hover:bg-violet-500/10 hover:text-violet-500 dark:text-violet-400 dark:hover:text-violet-300"
                        onClick={() => {
                          setCreatingAgent(false);
                          onAgentNavigate(
                            agent.agent_id,
                            "campaign",
                            "campaign-activity",
                          );
                        }}
                      >
                        <Megaphone className="size-3.5" aria-hidden />
                        View campaigns
                      </button>
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : stage === "campaign" ? (
          createdCampaign ? (
            <div className="space-y-8">
            <div className="overflow-hidden rounded-2xl border border-border bg-muted/20">
              <div className="border-b border-border/60 p-6 sm:p-8">
                <span className="flex size-12 items-center justify-center rounded-full bg-accent/10 text-accent">
                  <Check className="size-6" aria-hidden />
                </span>
                <Badge className="mt-5 border-accent/35 bg-accent/12 text-accent">
                  Campaign created
                </Badge>
                <h3 className="mt-3 text-2xl font-semibold">
                  {createdCampaign.campaignName}
                </h3>
                <p className="text-muted-foreground mt-2 max-w-xl text-sm leading-relaxed">
                  The v3 API accepted the outbound campaign for
                  {" "}{createdCampaign.recipientCount} recipient
                  {createdCampaign.recipientCount === 1 ? "" : "s"}.
                </p>
              </div>
              <div className="grid gap-px bg-border/60 sm:grid-cols-3">
                <div className="bg-background/80 p-5">
                  <p className="text-muted-foreground text-xs uppercase tracking-wider">
                    Campaign ID
                  </p>
                  <p className="mt-2 break-all font-mono text-sm">
                    {createdCampaign.campaignId || "Assigned by Agora"}
                  </p>
                </div>
                <div className="bg-background/80 p-5">
                  <p className="text-muted-foreground text-xs uppercase tracking-wider">
                    Recipients
                  </p>
                  <p className="mt-2 text-sm font-medium">
                    {createdCampaign.recipientCount}
                  </p>
                </div>
                <div className="bg-background/80 p-5">
                  <p className="text-muted-foreground text-xs uppercase tracking-wider">
                    Start
                  </p>
                  <p className="mt-2 text-sm font-medium">
                    {createdCampaign.startImmediately
                      ? "Immediately"
                      : new Date(
                          createdCampaign.scheduledStart || "",
                        ).toLocaleString([], {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                  </p>
                  {!createdCampaign.startImmediately && (
                    <p className="text-muted-foreground mt-1 text-xs">
                      {createdCampaign.timezone}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-3 p-6 sm:p-8">
                <Button
                  type="button"
                  onClick={() => {
                    setCreatedCampaign(null);
                    setCampaignName("Follow-up campaign");
                    setScheduledStart("");
                    setStartImmediately(true);
                    setNotice(null);
                  }}
                >
                  <Megaphone /> Configure another campaign
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onStageChange("agents")}
                >
                  All agents
                </Button>
              </div>
            </div>
            {renderCampaignHistory()}
            </div>
          ) : (
          <form onSubmit={createCampaign} className="space-y-6">
            {renderSelectedCallResources()}
            <div className="space-y-2">
              <Label htmlFor="campaignName">Campaign name</Label>
              <Input id="campaignName" value={campaignName} onChange={(e) => setCampaignName(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Label htmlFor="campaignRecipients">Recipients</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="border-input bg-background hover:bg-accent hover:text-accent-foreground inline-flex h-9 cursor-pointer items-center justify-center rounded-md border px-3 text-sm font-medium transition-colors">
                    Upload CSV
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      className="sr-only"
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = "";
                        if (file) void importCampaignCsv(file);
                      }}
                    />
                  </label>
                  <a
                    href="/campaign_template.csv"
                    download
                    className="text-muted-foreground text-xs underline underline-offset-4 hover:text-foreground"
                  >
                    Download template
                  </a>
                </div>
              </div>
              <Textarea
                id="campaignRecipients"
                className="min-h-36 font-mono"
                value={recipients}
                onChange={(e) => setRecipients(e.target.value)}
                placeholder={
                  "phone_number,sample_dynamic_variable,sample_dynamic_variable2\n+1234567890,John Smith,sample value"
                }
                required
              />
              <p className="text-muted-foreground text-xs">
                Enter one E.164 number per line, use name,number, or upload a CSV with a phone_number column. Additional columns become contact values for the agent&apos;s declared variables.
              </p>
            </div>
            <div className="space-y-4 rounded-xl border border-border bg-muted/15 p-4">
              <label className="flex items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={startImmediately}
                  onChange={(e) => {
                    const immediately = e.target.checked;
                    setStartImmediately(immediately);
                    if (!immediately && !scheduledStart) {
                      const defaultStart = new Date(Date.now() + 5 * 60_000);
                      defaultStart.setMinutes(
                        defaultStart.getMinutes() - defaultStart.getTimezoneOffset(),
                      );
                      setScheduledStart(defaultStart.toISOString().slice(0, 16));
                    }
                  }}
                  className="size-4"
                />
                Start immediately
              </label>
              {!startImmediately && (
                <div className="space-y-2">
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                    <div className="space-y-2">
                      <Label htmlFor="scheduledStartDate">Start date</Label>
                      <DatePicker
                        id="scheduledStartDate"
                        value={scheduledStart.split("T")[0] || ""}
                        min={minimumScheduledStart.split("T")[0]}
                        onValueChange={(date) =>
                          setScheduledStart(
                            date
                              ? `${date}T${scheduledStart.split("T")[1] || "09:00"}`
                              : "",
                          )
                        }
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="scheduledStartTime">Start time</Label>
                      <Input
                        id="scheduledStartTime"
                        type="time"
                        value={scheduledStart.split("T")[1] || ""}
                        min={
                          scheduledStart.split("T")[0] ===
                          minimumScheduledStart.split("T")[0]
                            ? minimumScheduledStart.split("T")[1]
                            : undefined
                        }
                        onChange={(event) => {
                          const date =
                            scheduledStart.split("T")[0] ||
                            minimumScheduledStart.split("T")[0];
                          setScheduledStart(`${date}T${event.target.value}`);
                        }}
                        required
                      />
                    </div>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    Scheduled in {timezone}. Calls are placed during a {CAMPAIGN_WINDOW_HOURS}-hour window from the start time.
                  </p>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="rounded-xl border border-border bg-muted/15 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1.5">
                    <p className="text-sm font-medium">CSV template</p>
                    <code className="text-muted-foreground block overflow-x-auto whitespace-nowrap text-xs">
                      phone_number,sample_dynamic_variable,sample_dynamic_variable2
                    </code>
                    <p className="text-muted-foreground text-xs leading-relaxed">
                      The <code>phone_number</code> column is required. Every
                      additional column becomes a contact value; declare it as
                      an agent variable and reference it as {"{{column_name}}"}.
                    </p>
                  </div>
                  <a
                    href="/campaign_template.csv"
                    download
                    className="inline-flex h-9 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-muted"
                  >
                    Download example CSV
                  </a>
                </div>
              </div>
              <Button type="submit" size="lg" disabled={savingCampaign || !selectedAgentId || !selectedPhoneNumberId}>
                {savingCampaign ? <Loader2 className="animate-spin" /> : startImmediately ? <Megaphone /> : <CalendarClock />}
                Create campaign
              </Button>
            </div>
            {renderCampaignHistory()}
          </form>
          )
        ) : stage === "phone" ? (
          <div className="mx-auto max-w-2xl text-center">
            {phoneNumbers.length > 0 && (
              <div className="mx-auto max-w-md space-y-2 text-left">
                <Label htmlFor="studioPhone">Registered source number</Label>
                <select
                  id="studioPhone"
                  className={selectClass}
                  value={selectedPhoneNumberId}
                  onChange={(event) => onPhoneNumberChange(event.target.value)}
                >
                  <option value="">Select a phone number</option>
                  {phoneNumbers.map((phone) => (
                    <option key={phone.number_id} value={phone.number_id}>
                      {phone.sip_trunk?.name || phone.description || "Phone"} · {phone.number || phone.number_id}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setPhoneDialogStandalone(false);
                  setPhoneDialogMode("add");
                  setPhoneDialogOpen(true);
                }}
              >
                <Phone /> Register a number
              </Button>
              <Button
                type="button"
                onClick={() => onStageChange("test")}
                disabled={!selectedAgentId || !selectedPhoneNumberId}
              >
                Continue to test call
              </Button>
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-2xl text-center">
            <div className="mx-auto mb-5 max-w-xl">
            </div>
            <form
              className="mx-auto max-w-xl rounded-2xl border border-border bg-muted/15 text-left"
              onSubmit={onTestCall}
            >
              <div className="grid gap-px bg-border/70 sm:grid-cols-2">
                <div className="flex min-w-0 items-center gap-3 bg-background/80 p-4">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
                    <Bot className="size-4" aria-hidden />
                  </span>
                  <div className="relative min-w-0 flex-1">
                    <p className="text-muted-foreground text-[10px] font-medium uppercase tracking-wider">
                      Agent
                    </p>
                    <div className="flex items-center gap-2">
                      <p className="min-w-0 flex-1 truncate text-sm font-semibold">
                        {activeAgent?.agent_name || "Selected agent"}
                      </p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      aria-label="Change agent"
                      title="Change agent"
                      onClick={() => {
                        setTestPhonePickerOpen(false);
                        setTestAgentPickerOpen((open) => !open);
                      }}
                    >
                      <Pencil />
                    </Button>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Badge className="shrink-0 border-accent/35 bg-accent/12 text-accent">
                        Live
                      </Badge>
                    </div>
                    {testAgentPickerOpen && (
                      <div className="absolute left-0 top-full z-20 mt-2 w-72 max-w-[calc(100vw-4rem)] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl">
                        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
                          <p className="text-xs font-semibold">Choose an agent</p>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            aria-label="Close agent picker"
                            onClick={() => setTestAgentPickerOpen(false)}
                          >
                            <X className="size-3.5" />
                          </Button>
                        </div>
                        <div className="max-h-64 overflow-y-auto p-1.5">
                          {agents.map((agent) => {
                            return (
                              <button
                                key={agent.agent_id}
                                type="button"
                                className={cn(
                                  "flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-muted",
                                  selectedAgentId === agent.agent_id &&
                                    "bg-muted",
                                )}
                                onClick={() => {
                                  setTestAgentPickerOpen(false);
                                  onAgentNavigate(agent.agent_id, "test");
                                }}
                              >
                                <span className="min-w-0">
                                  <span className="block truncate text-sm font-medium">
                                    {agent.agent_name || "Unnamed agent"}
                                  </span>
                                  <span className="text-muted-foreground block truncate font-mono text-[10px]">
                                    {agent.agent_id}
                                  </span>
                                </span>
                                <Badge
                                  variant="outline"
                                  className="shrink-0 border-accent/35 text-[10px] text-accent"
                                >
                                  Live
                                </Badge>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex min-w-0 items-center gap-3 bg-background/80 p-4">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
                    <Phone className="size-4" aria-hidden />
                  </span>
                  <div className="relative min-w-0 flex-1">
                    <p className="text-muted-foreground text-[10px] font-medium uppercase tracking-wider">
                      Calling from
                    </p>
                    <div className="flex items-center gap-2">
                      <p className="min-w-0 flex-1 truncate text-sm font-semibold">
                        {activePhone?.sip_trunk?.name || activePhone?.description || "Stored source number"}
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0"
                        aria-label="Change source phone number"
                        title="Change source phone number"
                        onClick={() => {
                          setTestAgentPickerOpen(false);
                          setTestPhonePickerOpen((open) => !open);
                        }}
                      >
                        <Pencil />
                      </Button>
                    </div>
                    <p className="text-muted-foreground mt-1 truncate font-mono text-xs">
                      {activePhone?.number ||
                        selectedPhoneNumberId ||
                        "No number selected"}
                    </p>
                    {testPhonePickerOpen && (
                      <div className="absolute right-0 top-full z-30 mt-2 w-72 max-w-[calc(100vw-4rem)] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl">
                        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
                          <p className="text-xs font-semibold">
                            Choose a source number
                          </p>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            aria-label="Close phone number picker"
                            onClick={() => setTestPhonePickerOpen(false)}
                          >
                            <X className="size-3.5" />
                          </Button>
                        </div>
                        <div className="max-h-64 overflow-y-auto p-1.5">
                          {phoneNumbers.length === 0 ? (
                            <p className="text-muted-foreground px-3 py-5 text-center text-xs">
                              No stored phone numbers.
                            </p>
                          ) : (
                            phoneNumbers.map((phone) => {
                              const numberId = phone.number_id;
                              return (
                                <button
                                  key={numberId}
                                  type="button"
                                  className={cn(
                                    "flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-muted",
                                    selectedPhoneNumberId === numberId &&
                                      "bg-muted",
                                  )}
                                  onClick={() => {
                                    onPhoneNumberChange(numberId);
                                    setTestPhonePickerOpen(false);
                                  }}
                                >
                                  <span className="min-w-0">
                                    <span className="block truncate text-sm font-medium">
                                      {phone.sip_trunk?.name || phone.description || "Stored source number"}
                                    </span>
                                    <span className="text-muted-foreground block truncate font-mono text-[11px]">
                                      {phone.number || numberId}
                                    </span>
                                  </span>
                                  {selectedPhoneNumberId === numberId && (
                                    <Check className="size-4 shrink-0 text-accent" />
                                  )}
                                </button>
                              );
                            })
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="space-y-3 p-5 sm:p-6">
                <Label htmlFor="studioTestDestination">Destination number</Label>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <div className="min-w-0 flex-1">
                    <PhoneField
                      id="studioTestDestination"
                      value={testDestination}
                      onChange={onTestDestinationChange}
                      disabled={testCallLoading}
                      invalid={testDestination.length > 0 && !isValidPhoneNumber(testDestination)}
                    />
                  </div>
                  <Button
                    type="submit"
                    className="shrink-0 sm:px-6"
                    disabled={
                      testCallLoading ||
                      !selectedAgentId ||
                      !selectedPhoneNumberId ||
                      !isValidPhoneNumber(testDestination)
                    }
                  >
                    {testCallLoading ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Phone />
                    )}
                    {testCallLoading ? "Starting call…" : "Call this number"}
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                  Enter an authorized international destination. It will be sent in E.164 format.
                </p>
              </div>
            </form>
            <Button
              type="button"
              variant="ghost"
              className="mt-4 cursor-pointer"
              onClick={() => onStageChange("campaign")}
            >
              Configure a campaign instead
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
    {agentPendingDeletion && (
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeAgentDeletion();
        }}
      >
        <Card
          className="relative max-h-[90vh] w-full max-w-xl overflow-y-auto border-destructive/35 shadow-2xl"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-agent-dialog-title"
          aria-describedby="delete-agent-dialog-description"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute top-3 right-3 z-10 cursor-pointer"
            aria-label="Close delete agent dialog"
            disabled={deletingAgent}
            onClick={closeAgentDeletion}
          >
            <X />
          </Button>
          <CardHeader>
            <CardTitle id="delete-agent-dialog-title">
              Delete {agentPendingDeletion.agent_name || "this agent"}?
            </CardTitle>
            <CardDescription id="delete-agent-dialog-description">
              This permanently removes the saved agent configuration.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>This action cannot be undone</AlertTitle>
              <AlertDescription>
                Existing session or campaign records may still reference this
                agent ID, but the configuration will no longer be available.
              </AlertDescription>
            </Alert>

            <div className="rounded-lg border border-border bg-muted/20 p-4">
              <p className="font-medium">
                {agentPendingDeletion.agent_name || "Unnamed agent"}
              </p>
              <p className="text-muted-foreground mt-1 break-all font-mono text-xs">
                {agentPendingDeletion.agent_id}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="delete-agent-confirmation">
                Type <span className="font-mono font-semibold">delete</span> to
                confirm
              </Label>
              <Input
                id="delete-agent-confirmation"
                value={deleteAgentConfirmation}
                onChange={(event) =>
                  setDeleteAgentConfirmation(event.target.value)
                }
                placeholder="delete"
                autoComplete="off"
                spellCheck={false}
                disabled={deletingAgent}
                autoFocus
              />
              <p className="text-muted-foreground text-xs">
                The confirmation must match exactly before the final delete
                action is enabled.
              </p>
            </div>

            {blockingDeletionCampaigns.length > 0 && (
              <Alert className="border-amber-500/35 bg-amber-500/8">
                <TriangleAlert className="text-amber-500" />
                <AlertTitle>
                  Campaign cleanup required
                </AlertTitle>
                <AlertDescription>
                  <p>
                    {blockingDeletionCampaigns.length} scheduled, running, or
                    paused campaign
                    {blockingDeletionCampaigns.length === 1 ? "" : "s"} still
                    reference this agent. Cancel or finish{" "}
                    {blockingDeletionCampaigns.length === 1 ? "it" : "them"}{" "}
                    before deleting.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => {
                      const agentId = agentPendingDeletion.agent_id;
                      closeAgentDeletion();
                      setCreatingAgent(false);
                      onAgentNavigate(
                        agentId,
                        "campaign",
                        "campaign-activity",
                      );
                    }}
                  >
                    <Megaphone /> Review campaigns
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            {deleteAgentError && (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertTitle>Could not delete agent</AlertTitle>
                <AlertDescription>{deleteAgentError}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={deletingAgent}
                onClick={closeAgentDeletion}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={
                  deletingAgent ||
                  blockingDeletionCampaigns.length > 0 ||
                  deleteAgentConfirmation !== "delete"
                }
                onClick={() => void deletePendingAgent()}
              >
                {deletingAgent ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Trash2 />
                )}
                {deletingAgent ? "Checking and deleting…" : "Delete agent"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )}
    {secretManagerOpen && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSecretManagerOpen(false);
        }}
      >
          <Card
          className="relative max-h-[90vh] w-full max-w-2xl overflow-y-auto border-border shadow-2xl"
          role="dialog"
          aria-modal="true"
          aria-labelledby="secret-manager-title"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute top-3 right-3 z-10 cursor-pointer"
            aria-label="Close secret manager"
            onClick={() => setSecretManagerOpen(false)}
          >
            <X />
          </Button>
          <CardHeader>
            <CardTitle id="secret-manager-title">Manage secrets</CardTitle>
            <CardDescription>
              Secret sets hold write-only provider keys. Agents reference them as{" "}
              <code>$secrets.&lt;set&gt;.&lt;key&gt;</code>; values are never returned.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              {secretSets.length > 0 ? secretSets.map((set) => (
                <div
                  key={set.name}
                  className="space-y-2 rounded-lg border border-border bg-muted/20 px-4 py-3"
                >
                  <p className="font-mono text-sm font-medium">{set.name}</p>
                  <div className="flex flex-wrap gap-2">
                    {secretKeys(set).length > 0 ? (
                      secretKeys(set).map((key) => (
                        <Badge key={key} variant="outline" className="font-mono">
                          {key}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-muted-foreground text-xs">No keys</span>
                    )}
                  </div>
                </div>
              )) : (
                <p className="text-muted-foreground rounded-lg border border-dashed border-border p-5 text-center text-sm">
                  No secret sets yet.
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-border pt-5">
              <Button type="button" variant="ghost" onClick={() => setSecretManagerOpen(false)}>
                Close
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setSecretManagerOpen(false);
                  openSecretDialog(undefined, undefined, true);
                }}
              >
                <KeyRound /> Add secret
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )}
    {secretDialog && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeSecretDialog();
        }}
      >
        <Card
          className="relative max-h-[90vh] w-full max-w-xl overflow-y-auto border-border shadow-2xl"
          role="dialog"
          aria-modal="true"
          aria-labelledby="secret-dialog-title"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute top-3 right-3 z-10 cursor-pointer"
            aria-label="Close secret dialog"
            onClick={closeSecretDialog}
          >
            <X />
          </Button>
          <CardHeader>
            <CardTitle id="secret-dialog-title">
              {secretDialog.kind
                ? `Store a ${secretDialog.kind.toUpperCase()} provider key`
                : "Add a secret"}
            </CardTitle>
            <CardDescription>
              The value is sent through the authenticated server route to the v3
              secrets API. It is write-only and never stored in the browser.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={saveSecret} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="secretSetName">Secret set</Label>
                  <Input
                    id="secretSetName"
                    list="secretSetNames"
                    value={secretSetName}
                    onChange={(event) => setSecretSetName(event.target.value)}
                    required
                    autoFocus
                  />
                  <datalist id="secretSetNames">
                    {secretSets.map((set) => (
                      <option key={set.name} value={set.name} />
                    ))}
                  </datalist>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="secretKeyName">Key</Label>
                  <Input
                    id="secretKeyName"
                    value={secretKeyName}
                    onChange={(event) => setSecretKeyName(event.target.value)}
                    placeholder="openai_api_key"
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="secretValue">Value</Label>
                <Input
                  id="secretValue"
                  type="password"
                  value={secretValue}
                  onChange={(event) => setSecretValue(event.target.value)}
                  required
                  autoComplete="off"
                />
                <p className="text-muted-foreground text-xs">
                  Names use letters, digits, and underscores. An existing set gets
                  this key added or rotated.
                </p>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={closeSecretDialog}>
                  Cancel
                </Button>
                <Button type="submit" disabled={savingSecret}>
                  {savingSecret ? <Loader2 className="animate-spin" /> : <KeyRound />}
                  Save secret
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    )}
    {phoneDialogOpen && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) closePhoneDialog();
        }}
      >
        <Card
          className="relative max-h-[90vh] w-full max-w-xl overflow-y-auto border-border shadow-2xl"
          role="dialog"
          aria-modal="true"
          aria-labelledby="phone-dialog-title"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute top-3 right-3 z-10 cursor-pointer"
            aria-label="Close phone number manager"
            onClick={closePhoneDialog}
          >
            <X />
          </Button>
          <CardHeader>
            <CardTitle id="phone-dialog-title">
              {phoneDialogMode === "list" ? "Manage phone numbers" : "Register a phone number"}
            </CardTitle>
            <CardDescription>
              {phoneDialogMode === "list"
                ? "Review and select the source numbers registered for this project."
                : "Register a SIP-capable source number you control. Registration does not purchase a number or create a SIP trunk."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {phoneDialogMode === "list" ? (
              <>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-sm font-semibold">Stored phone numbers</h4>
                <Badge variant="outline">{phoneNumbers.length}</Badge>
              </div>
              {phoneNumbers.length > 0 ? (
                phoneNumbers.map((phone) => {
                  const numberId = phone.number_id;
                  const selected = numberId === selectedPhoneNumberId;
                  return (
                    <div
                      key={numberId}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {phone.sip_trunk?.name || phone.description || "Unnamed source number"}
                        </p>
                        <p className="mt-1 text-sm">{phone.number || "Number unavailable"}</p>
                        <p className="text-muted-foreground mt-1 font-mono text-[11px]">
                          Phone number ID: {numberId}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {phone.sip_trunk?.hostname && (
                          <Badge variant="outline" className="border-accent/35 text-accent">
                            {(phone.sip_trunk.transport || "udp").toUpperCase()} · {phone.sip_trunk.hostname}
                          </Badge>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant={selected ? "secondary" : "outline"}
                          disabled={selected}
                          onClick={() => {
                            onPhoneNumberChange(numberId);
                            closePhoneDialog();
                          }}
                        >
                          {selected ? "Selected" : "Use number"}
                        </Button>
                      </div>
                    </div>
                  );
                })
              ) : (
                <p className="text-muted-foreground rounded-lg border border-dashed border-border p-5 text-center text-sm">
                  No stored phone numbers yet.
                </p>
              )}
            </div>
            <Button
              type="button"
              className="w-full"
              onClick={() => setPhoneDialogMode("add")}
            >
              <Phone /> Add new number
            </Button>
              </>
            ) : (
            <form onSubmit={savePhoneNumber} className="space-y-5">
              <div>
                {phoneDialogStandalone && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mb-3"
                    onClick={() => {
                      resetPhoneForm();
                      setPhoneDialogMode("list");
                    }}
                  >
                    All phone numbers
                  </Button>
                )}
                <h4 className="text-sm font-semibold">Number details</h4>
                <p className="text-muted-foreground mt-1 text-xs">
                  The number is registered to this project and can be selected for tests and campaigns.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="phoneRecordName">SIP trunk name</Label>
                <Input
                  id="phoneRecordName"
                  value={phoneRecordName}
                  onChange={(event) => setPhoneRecordName(event.target.value)}
                  placeholder="Primary outbound line"
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phoneRecordNumber">Phone number</Label>
                <PhoneField
                  id="phoneRecordNumber"
                  value={phoneRecordNumber}
                  onChange={setPhoneRecordNumber}
                  invalid={
                    phoneRecordNumber.length > 0 &&
                    !isValidPhoneNumber(phoneRecordNumber)
                  }
                />
                <p className="text-muted-foreground text-xs">
                  Use the E.164 source number assigned by your telephony or SIP provider.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="sipGatewayHost">SIP gateway host</Label>
                  <Input
                    id="sipGatewayHost"
                    value={sipGatewayHost}
                    onChange={(event) => setSipGatewayHost(event.target.value)}
                    placeholder="sip.provider.example.com"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sipSignalingPort">SIP signaling port</Label>
                  <Input
                    id="sipSignalingPort"
                    type="number"
                    min="1"
                    max="65535"
                    value={sipSignalingPort}
                    onChange={(event) => setSipSignalingPort(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sipTransport">SIP transport</Label>
                  <select
                    id="sipTransport"
                    className={selectClass}
                    value={sipTransport}
                    onChange={(event) =>
                      setSipTransport(event.target.value as "udp" | "tcp" | "tls")
                    }
                  >
                    <option value="udp">UDP</option>
                    <option value="tcp">TCP</option>
                    <option value="tls">TLS</option>
                  </select>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="phoneDescription">Description</Label>
                <Textarea
                  id="phoneDescription"
                  value={phoneDescription}
                  onChange={(event) => setPhoneDescription(event.target.value)}
                  placeholder="Optional routing or ownership note"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    if (phoneDialogStandalone) {
                      resetPhoneForm();
                      setPhoneDialogMode("list");
                    } else {
                      closePhoneDialog();
                    }
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={savingPhoneNumber}>
                  {savingPhoneNumber ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Phone />
                  )}
                  Register number
                </Button>
              </div>
            </form>
            )}
          </CardContent>
        </Card>
      </div>
    )}
    </>
  );
}
