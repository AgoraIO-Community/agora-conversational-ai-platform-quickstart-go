import { Fragment, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  TTS_VOICE_FIELD_PATHS,
  TTS_VOICE_URLS,
} from "@/data/tts-voice-catalogs";

export type ProviderConfigValues = Record<string, string | boolean>;
type Kind = "asr" | "llm" | "tts";
type Field = {
  path: string; label: string; type?: "text" | "url" | "number" | "select" | "boolean" | "textarea" | "csv";
  defaultValue?: string | boolean; placeholder?: string; required?: boolean;
  section?: "model";
  options?: Array<{ label: string; value: string }>; min?: number; max?: number; step?: number;
};
const f = (path: string, label: string, options: Omit<Field, "path" | "label"> = {}): Field => ({ path, label, ...options });
const choices = (...values: string[]) => values.map((value) => ({ label: value, value }));
const rates = choices("8000", "16000", "22050", "24000", "44100", "48000");

const ASR: Record<string, Field[]> = {
  ares: [],
  deepgram: [f("model", "Model", { type: "select", defaultValue: "nova-3", options: choices("nova-3", "nova-2"), section: "model" }), f("url", "WebSocket URL", { type: "url", defaultValue: "wss://api.deepgram.com/v1/listen" }), f("keyterm", "Keywords", { placeholder: "Agora%20Winnfield" })],
  microsoft: [f("phrase_list", "Phrase list", { type: "csv", placeholder: "Agora, conversational AI" })],
  openai: [f("input_audio_transcription.model", "Model", { defaultValue: "gpt-4o-mini-transcribe", required: true, section: "model" }), f("input_audio_transcription.prompt", "Transcription prompt", { type: "textarea", defaultValue: "Transcribe the caller accurately." })],
  speechmatics: [f("uri", "WebSocket URL", { type: "url", defaultValue: "wss://eu2.rt.speechmatics.com/v2" })],
  assemblyai: [f("uri", "WebSocket URL", { type: "url", defaultValue: "wss://streaming.assemblyai.com/v3/ws" })],
  amazon: [f("media_sample_rate_hz", "Sample rate", { type: "select", defaultValue: "16000", options: rates }), f("media_encoding", "Encoding", { type: "select", defaultValue: "pcm", options: choices("pcm", "opus", "flac") })],
  google: [f("project_id", "Google Cloud project ID", { required: true }), f("location", "Location", { defaultValue: "global", required: true }), f("model", "Model", { defaultValue: "long", section: "model" })],
  sarvam: [],
  xai: [f("base_url", "WebSocket URL", { type: "url", defaultValue: "wss://api.x.ai/v1/stt" }), f("sample_rate", "Sample rate", { type: "select", defaultValue: "16000", options: rates })],
};

const LLM: Record<string, Field[]> = {
  openai: [f("url", "Endpoint", { type: "url", defaultValue: "https://api.openai.com/v1/chat/completions", required: true }), f("params.model", "Model", { type: "select", defaultValue: "gpt-4o-mini", required: true, options: [{ label: "GPT-4o mini", value: "gpt-4o-mini" }, { label: "GPT-4.1 mini", value: "gpt-4.1-mini" }, { label: "GPT-5 nano", value: "gpt-5-nano" }, { label: "GPT-5 mini", value: "gpt-5-mini" }] })],
  azure: [f("url", "Deployment endpoint", { type: "url", placeholder: "https://RESOURCE.openai.azure.com/openai/deployments/DEPLOYMENT/chat/completions?api-version=VERSION", required: true }), f("params.model", "Deployment name", { defaultValue: "gpt-4o-mini", required: true })],
  groq: [f("url", "Endpoint", { type: "url", defaultValue: "https://api.groq.com/openai/v1/chat/completions", required: true }), f("params.model", "Model", { defaultValue: "llama-3.3-70b-versatile", required: true })],
  gemini: [f("url", "Streaming endpoint", { type: "url", defaultValue: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse", required: true }), f("params.model", "Model", { defaultValue: "gemini-2.0-flash", required: true }), f("ignore_empty", "Ignore empty responses", { type: "boolean", defaultValue: true })],
  google: [f("url", "Vertex AI endpoint", { type: "url", placeholder: "https://REGION-aiplatform.googleapis.com/v1/projects/PROJECT/locations/REGION/publishers/google/models/MODEL:streamGenerateContent?alt=sse", required: true }), f("params.model", "Model", { defaultValue: "gemini-2.0-flash-001", required: true })],
  anthropic: [f("url", "Messages endpoint", { type: "url", defaultValue: "https://api.anthropic.com/v1/messages", required: true }), f("params.model", "Model", { defaultValue: "claude-3-5-haiku-latest", required: true }), f("params.max_tokens", "Maximum tokens", { type: "number", defaultValue: "1024", min: 1, required: true }), f("headers", "Headers", { defaultValue: "{\"anthropic-version\":\"2023-06-01\"}", required: true })],
  amazon: [f("url", "Bedrock endpoint", { type: "url", defaultValue: "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-4-20250514-v1:0/converse-stream", required: true }), f("region", "Region", { defaultValue: "us-east-1", required: true }), f("model", "Model", { defaultValue: "us.anthropic.claude-sonnet-4-20250514-v1:0", required: true })],
  dify: [f("url", "Dify endpoint", { type: "url", placeholder: "https://example.ai-plugin.io/convoai/dify-completion", required: true }), f("params.model", "Model", { defaultValue: "default", required: true })],
  xai: [f("url", "Endpoint", { type: "url", defaultValue: "https://api.x.ai/v1/chat/completions", required: true }), f("params.model", "Model", { defaultValue: "grok-4.3", required: true })],
  custom: [f("url", "OpenAI-compatible endpoint", { type: "url", placeholder: "https://your-llm.example/v1/chat/completions", required: true }), f("params.model", "Model", { placeholder: "your-model", required: true })],
};

const TTS: Record<string, Field[]> = {
  minimax: [f("url", "WebSocket URL", { type: "url", defaultValue: "wss://api-uw.minimax.io/ws/v1/t2a_v2", required: true }), f("model", "Model", { type: "select", defaultValue: "speech-2.8-turbo", required: true, options: [{ label: "Speech 2.8 Turbo", value: "speech-2.8-turbo" }, { label: "Speech 2.6 Turbo", value: "speech-2.6-turbo" }] }), f("voice_setting.voice_id", "Voice ID", { defaultValue: "English_radiant_girl", required: true }), f("voice_setting.speed", "Speed", { type: "number", defaultValue: "1", min: 0.5, max: 2, step: 0.1 }), f("audio_setting.sample_rate", "Sample rate", { type: "select", defaultValue: "24000", options: rates })],
  microsoft: [f("voice_name", "Voice", { defaultValue: "en-US-AndrewMultilingualNeural", required: true }), f("speed", "Speed", { type: "number", defaultValue: "1", min: 0.5, max: 2, step: 0.1 }), f("volume", "Volume", { type: "number", defaultValue: "100", min: 0, max: 100 }), f("sample_rate", "Sample rate", { type: "select", defaultValue: "24000", options: rates })],
  elevenlabs: [f("base_url", "WebSocket URL", { type: "url", defaultValue: "wss://api.elevenlabs.io/v1", required: true }), f("model_id", "Model", { defaultValue: "eleven_flash_v2_5", required: true }), f("voice_id", "Voice ID", { required: true }), f("sample_rate", "Sample rate", { type: "select", defaultValue: "24000", options: rates }), f("speed", "Speed", { type: "number", defaultValue: "1", min: 0.7, max: 1.2, step: 0.05 }), f("stability", "Stability", { type: "number", defaultValue: "0.5", min: 0, max: 1, step: 0.05 }), f("similarity_boost", "Similarity boost", { type: "number", defaultValue: "0.75", min: 0, max: 1, step: 0.05 }), f("style", "Style", { type: "number", defaultValue: "0", min: 0, max: 1, step: 0.05 }), f("use_speaker_boost", "Speaker boost", { type: "boolean", defaultValue: true })],
  deepgram: [f("base_url", "WebSocket URL", { type: "url", defaultValue: "wss://api.deepgram.com/v1/speak" }), f("model", "Voice model", { defaultValue: "aura-2-thalia-en", required: true }), f("sample_rate", "Sample rate", { type: "select", defaultValue: "24000", options: rates })],
  murf: [f("base_url", "WebSocket URL", { type: "url", defaultValue: "wss://global.api.murf.ai/v1/speech/stream-input" }), f("voiceId", "Voice", { defaultValue: "Matthew" }), f("locale", "Locale", { defaultValue: "en-US" }), f("model", "Model", { defaultValue: "FALCON" }), f("rate", "Rate", { type: "number", defaultValue: "0", step: 0.1 }), f("pitch", "Pitch", { type: "number", defaultValue: "0", step: 0.1 }), f("sample_rate", "Sample rate", { type: "select", defaultValue: "24000", options: rates })],
  cartesia: [f("base_url", "WebSocket URL", { type: "url", defaultValue: "wss://api.cartesia.ai" }), f("model_id", "Model", { defaultValue: "sonic-2", required: true }), f("voice.mode", "Voice selection", { type: "select", defaultValue: "id", options: [{ label: "Voice ID", value: "id" }] }), f("voice.id", "Voice ID", { required: true }), f("language", "Language", { defaultValue: "en" }), f("output_format.container", "Container", { defaultValue: "raw" }), f("output_format.sample_rate", "Sample rate", { type: "select", defaultValue: "16000", options: rates })],
  openai: [f("base_url", "API base URL", { type: "url", defaultValue: "https://api.openai.com/v1", required: true }), f("model", "Model", { defaultValue: "gpt-4o-mini-tts", required: true }), f("voice", "Voice", { defaultValue: "coral", required: true }), f("instructions", "Voice instructions", { type: "textarea", placeholder: "Natural tone, moderate pace" }), f("speed", "Speed", { type: "number", defaultValue: "1", min: 0.25, max: 4, step: 0.1 })],
  humeai: [f("base_url", "API base URL", { type: "url", defaultValue: "https://api.hume.ai" }), f("voice_id", "Voice ID", { required: true }), f("provider", "Voice provider", { type: "select", defaultValue: "HUME_AI", options: choices("HUME_AI", "CUSTOM_VOICE") }), f("speed", "Speed", { type: "number", defaultValue: "1", min: 0.25, max: 3, step: 0.1 }), f("trailing_silence", "Trailing silence", { type: "number", defaultValue: "0.35", min: 0, max: 5, step: 0.05 })],
  rime: [f("base_url", "WebSocket URL", { type: "url", defaultValue: "wss://users.rime.ai/ws2" }), f("speaker", "Speaker", { defaultValue: "cove", required: true }), f("modelId", "Model", { defaultValue: "mistv2", required: true })],
  fishaudio: [f("reference_id", "Voice model ID", { required: true }), f("backend", "Backend model", { defaultValue: "speech-1.5", required: true })],
  google: [f("VoiceSelectionParams.name", "Voice", { defaultValue: "en-US-Chirp3-HD-Charon", required: true }), f("AudioConfig.speaking_rate", "Speaking rate", { type: "number", defaultValue: "1", min: 0.25, max: 2, step: 0.1 }), f("AudioConfig.sample_rate_hertz", "Sample rate", { type: "select", defaultValue: "24000", options: rates })],
  amazon: [f("voice", "Voice", { defaultValue: "Joanna", required: true }), f("engine", "Engine", { type: "select", defaultValue: "neural", required: true, options: choices("standard", "neural", "long-form", "generative") })],
  sarvam: [f("speaker", "Speaker", { type: "select", defaultValue: "anushka", required: true, options: choices("anushka", "manisha", "vidya", "arya", "abhilash", "karun", "hitesh") }), f("target_language_code", "Language", { defaultValue: "en-IN", required: true }), f("pitch", "Pitch", { type: "number", defaultValue: "0", min: -0.75, max: 0.75, step: 0.05 }), f("pace", "Pace", { type: "number", defaultValue: "1", min: 0.3, max: 3, step: 0.1 }), f("loudness", "Loudness", { type: "number", defaultValue: "1", min: 0.1, max: 3, step: 0.1 }), f("sample_rate", "Sample rate", { type: "select", defaultValue: "24000", options: rates })],
  xai: [f("voice_id", "Voice ID", { defaultValue: "eve" }), f("language", "Language", { defaultValue: "en", required: true }), f("sample_rate", "Sample rate", { type: "select", defaultValue: "16000", options: rates })],
};

const languagePaths: Record<string, string> = { deepgram: "language", microsoft: "language", openai: "input_audio_transcription.language", speechmatics: "language", assemblyai: "language", amazon: "language_code", google: "language", sarvam: "language", xai: "language" };
const fieldsFor = (kind: Kind, vendor: string) => (kind === "asr" ? ASR : kind === "llm" ? LLM : TTS)[vendor] || [];
export const defaultProviderValues = (kind: Kind, vendor: string): ProviderConfigValues => Object.fromEntries(fieldsFor(kind, vendor).filter((field) => field.defaultValue !== undefined).map((field) => [field.path, field.defaultValue as string | boolean]));
function getNested(source: Record<string, unknown>, path: string) { return path.split(".").reduce<unknown>((value, key) => typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined, source); }
export function providerValuesFromParams(kind: Kind, vendor: string, params: Record<string, unknown>) { const values = defaultProviderValues(kind, vendor); fieldsFor(kind, vendor).forEach((field) => { const value = getNested(params, field.path); if (typeof value === "string" || typeof value === "boolean") values[field.path] = value; else if (typeof value === "number") values[field.path] = String(value); else if (Array.isArray(value)) values[field.path] = value.join(", "); }); return values; }
function setNested(target: Record<string, unknown>, path: string, value: unknown) { const keys = path.split("."); let cursor = target; keys.forEach((key, index) => { if (index === keys.length - 1) cursor[key] = value; else { if (typeof cursor[key] !== "object" || cursor[key] === null) cursor[key] = {}; cursor = cursor[key] as Record<string, unknown>; } }); }
export function buildProviderParams(kind: Kind, vendor: string, values: ProviderConfigValues, language?: string) { const params: Record<string, unknown> = {}; fieldsFor(kind, vendor).forEach((field) => { const value = values[field.path]; if (value === "" || value === undefined) return; const parsed = field.type === "number" || field.type === "select" && /^\d+(\.\d+)?$/.test(String(value)) ? Number(value) : field.type === "csv" ? String(value).split(",").map((item) => item.trim()).filter(Boolean) : value; setNested(params, field.path, parsed); }); if (kind === "asr" && languagePaths[vendor] && language?.trim()) setNested(params, languagePaths[vendor], language.trim()); return params; }

function VoiceField({
  id,
  required,
  update,
  value,
  voicesUrl,
}: {
  id: string;
  required?: boolean;
  update: (next: string) => void;
  value: string;
  voicesUrl: string;
}) {
  return (
    <div className="space-y-2">
      <Input
        id={id}
        value={value}
        onChange={(event) => update(event.target.value)}
        placeholder="Enter voice ID"
        required={required}
      />
      <a
        className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        href={voicesUrl}
        target="_blank"
        rel="noreferrer"
      >
        Discover all supported voices
        <ExternalLink className="size-3" aria-hidden="true" />
      </a>
    </div>
  );
}

export function ProviderConfigFields({ kind, vendor, values, onChange, section, emptyLabel, afterModelField }: { kind: Kind; vendor: string; values: ProviderConfigValues; onChange: (values: ProviderConfigValues) => void; section?: "model" | "settings"; emptyLabel?: string; afterModelField?: ReactNode }) {
  const fields = fieldsFor(kind, vendor).filter((field) =>
    (!section || (section === "model" ? field.section === "model" : field.section !== "model")),
  );
  if (!fields.length && emptyLabel) return <div className="space-y-2"><Label>Model</Label><p className="border-input bg-muted/20 rounded-md border px-3 py-2 text-sm text-muted-foreground">{emptyLabel}</p></div>;
  if (!fields.length) return <p className="text-muted-foreground text-sm">No additional provider settings.</p>;
  return (
    <div className={kind === "llm" ? "grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(12rem,0.7fr)]" : section === "model" ? "grid gap-4" : "grid gap-4 sm:grid-cols-2 xl:grid-cols-3"}>
      {fields.map((field) => {
        const id = `${kind}-${vendor}-${field.path.replaceAll(".", "-")}`;
        const value = values[field.path] ?? field.defaultValue ?? "";
        const update = (next: string | boolean) => onChange({ ...values, [field.path]: next });
        const voiceUrl = kind === "tts" && TTS_VOICE_FIELD_PATHS[vendor] === field.path
          ? TTS_VOICE_URLS[vendor]
          : undefined;
        const isModelField = /(^|\.)(model|model_id|modelId)$/.test(field.path) || field.path === "backend";
        const modelOptions = field.options?.length
          ? field.options
          : field.defaultValue !== undefined
            ? [{ label: String(field.defaultValue), value: String(field.defaultValue) }]
            : [];
        const isKnownModel = modelOptions.some((option) => option.value === String(value));
        const customModelSelected = isModelField && !isKnownModel;
        const isLlmModel = kind === "llm" && (field.path === "params.model" || field.path === "model");
        const fieldClass = kind === "llm"
          ? isLlmModel ? "space-y-2" : "space-y-2 sm:col-span-2"
          : kind === "asr" && (field.type === "url" || (vendor === "deepgram" && field.path === "keyterm"))
            ? "space-y-2 sm:col-span-2 xl:col-span-3"
            : field.type === "textarea" || field.type === "csv"
              ? "space-y-2 sm:col-span-2"
              : "space-y-2";
        return (
          <Fragment key={`${vendor}:${field.path}`}>
            <div className={fieldClass}>
              <Label htmlFor={id}>{field.label}</Label>
              {voiceUrl ? (
                <VoiceField
                  id={id}
                  required={field.required}
                  update={update}
                  value={String(value)}
                  voicesUrl={voiceUrl}
                />
              ) : isModelField ? (
                <div className="space-y-2">
                  <select
                    id={id}
                    className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                    value={customModelSelected ? "__other__" : String(value)}
                    onChange={(event) => update(event.target.value === "__other__" ? "" : event.target.value)}
                    required={field.required}
                  >
                    {modelOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    <option value="__other__">Other</option>
                  </select>
                  {customModelSelected && (
                    <Input
                      id={`${id}-custom`}
                      value={String(value)}
                      onChange={(event) => update(event.target.value)}
                      placeholder="Enter model ID"
                      required={field.required}
                      autoFocus
                    />
                  )}
                </div>
              ) : field.type === "select" ? <select id={id} className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm" value={String(value)} onChange={(event) => update(event.target.value)} required={field.required}>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : field.type === "boolean" ? <label className="border-input flex h-9 items-center gap-2 rounded-md border px-3 text-sm"><input type="checkbox" checked={Boolean(value)} onChange={(event) => update(event.target.checked)} /> Enabled</label> : field.type === "textarea" || field.type === "csv" ? <Textarea id={id} value={String(value)} onChange={(event) => update(event.target.value)} placeholder={field.placeholder} required={field.required} /> : <Input id={id} type={field.type === "number" ? "number" : field.type === "url" ? "url" : "text"} value={String(value)} onChange={(event) => update(event.target.value)} placeholder={field.placeholder} required={field.required} min={field.min} max={field.max} step={field.step} />}
            </div>
            {isLlmModel && afterModelField}
          </Fragment>
        );
      })}
    </div>
  );
}
