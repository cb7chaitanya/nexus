"use client";

import { useEffect, useState } from "react";
import { LLM_PROVIDER_MODELS, LLM_PROVIDERS, type LlmConfigProvider } from "@raas/shared";
import { CheckCircle2Icon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";

import { useSession } from "@/lib/session-context";
import { useDeleteLlmConfig, useLlmConfig, useSetLlmConfig, useTestLlmConfig } from "@/hooks/use-llm-config";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

const PROVIDER_LABELS: Record<LlmConfigProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  groq: "Groq",
};

type Selection = "nexus" | LlmConfigProvider;

export default function AiProviderPage() {
  const { currentOrganization } = useSession();
  const canManage = currentOrganization.role === "OWNER" || currentOrganization.role === "ADMIN";

  const llmConfig = useLlmConfig(currentOrganization.id);
  const setLlmConfig = useSetLlmConfig(currentOrganization.id);
  const deleteLlmConfig = useDeleteLlmConfig(currentOrganization.id);
  const testLlmConfig = useTestLlmConfig(currentOrganization.id);

  const saved = llmConfig.data?.config ?? null;

  const [selection, setSelection] = useState<Selection>("nexus");
  const [model, setModel] = useState<string>("");
  const [apiKey, setApiKey] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string } | null>(null);

  // Syncs the form to whatever's actually saved once it loads — only on
  // the initial load (llmConfig.data flips from undefined to a value),
  // never overwriting an in-progress edit on a background refetch.
  useEffect(() => {
    if (!llmConfig.data) return;
    if (llmConfig.data.config) {
      setSelection(llmConfig.data.config.provider);
      setModel(llmConfig.data.config.model);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial sync only, see comment above
  }, [llmConfig.data === undefined]);

  const models = selection === "nexus" ? [] : LLM_PROVIDER_MODELS[selection];
  const isDirty = selection !== (saved?.provider ?? "nexus") || model !== (saved?.model ?? "") || apiKey.length > 0;

  function selectProvider(next: Selection) {
    setSelection(next);
    setModel(next === "nexus" ? "" : LLM_PROVIDER_MODELS[next][0]!);
    setApiKey("");
    setTestResult(null);
  }

  async function handleTest() {
    if (selection === "nexus") return;
    setTestResult(null);
    try {
      const result = await testLlmConfig.mutateAsync({ provider: selection, model, apiKey: apiKey || undefined });
      setTestResult(result);
    } catch {
      setTestResult({ ok: false, message: "Couldn't reach the test endpoint. Please try again." });
    }
  }

  async function handleSave() {
    try {
      if (selection === "nexus") {
        await deleteLlmConfig.mutateAsync();
        toast.success("Switched to Nexus-managed inference.");
        return;
      }
      if (!apiKey) {
        toast.error("Enter your API key to save.");
        return;
      }
      await setLlmConfig.mutateAsync({ provider: selection, model, apiKey });
      setApiKey("");
      setTestResult(null);
      toast.success(`Now using your own ${PROVIDER_LABELS[selection]} account for chat.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save. Please try again.");
    }
  }

  if (llmConfig.isLoading) {
    return (
      <div className="max-w-2xl space-y-4">
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <Card className="py-5">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-base">Current provider</CardTitle>
          {saved ? (
            <Badge variant={saved.lastValidationError ? "warning" : "success"} className="gap-1">
              {saved.lastValidationError ? <TriangleAlertIcon className="size-3" /> : <CheckCircle2Icon className="size-3" />}
              {saved.lastValidationError ? "Needs attention" : "Healthy"}
            </Badge>
          ) : (
            <Badge variant="outline">Nexus-managed</Badge>
          )}
        </CardHeader>
        <CardContent>
          {saved ? (
            <div className="space-y-1 text-sm text-muted-foreground">
              <p>
                Chat requests use your own <span className="font-medium text-foreground">{PROVIDER_LABELS[saved.provider]}</span> account (
                <span className="font-mono">{saved.model}</span>).
              </p>
              {saved.lastValidatedAt && <p>Last checked {new Date(saved.lastValidatedAt).toLocaleString()}.</p>}
              {saved.lastValidationError && <p className="text-warning">{saved.lastValidationError}</p>}
              <p>
                If this key stops working, chat requests fail with a clear error — Nexus never silently falls back to
                its own account on your behalf.
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Chat is using Nexus&apos;s own OpenAI/Groq account. Switch to your own OpenAI, Anthropic, or Groq key
              below if you&apos;d rather chat traffic run through your own account.
            </p>
          )}
        </CardContent>
      </Card>

      {!canManage ? (
        <p className="text-sm text-muted-foreground">Only an owner or admin can change the AI provider for this organization.</p>
      ) : (
        <Card className="py-5">
          <CardHeader>
            <CardTitle className="text-base">Change provider</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <Select value={selection} onValueChange={(value) => selectProvider(value as Selection)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="nexus">Nexus-managed</SelectItem>
                  {LLM_PROVIDERS.map((provider) => (
                    <SelectItem key={provider} value={provider}>
                      {PROVIDER_LABELS[provider]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selection !== "nexus" && (
              <>
                <div className="space-y-1.5">
                  <Label>Model</Label>
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {models.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="provider-api-key">API key</Label>
                  <Input
                    id="provider-api-key"
                    type="password"
                    autoComplete="off"
                    placeholder={saved ? "•••• configured — enter a new key to change it" : "sk-..."}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setTestResult(null);
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    Stored encrypted. Never shown again after saving — {saved ? "leave blank to keep the current key" : "required to save"}.
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <Button type="button" variant="outline" size="sm" onClick={() => void handleTest()} disabled={testLlmConfig.isPending}>
                    {testLlmConfig.isPending && <Loader2Icon className="animate-spin" />}
                    Test connection
                  </Button>
                  {testResult && (
                    <span className={`text-sm ${testResult.ok ? "text-success" : "text-destructive"}`}>
                      {testResult.ok ? "Connection succeeded." : testResult.message}
                    </span>
                  )}
                </div>
              </>
            )}

            <Button onClick={() => void handleSave()} disabled={!isDirty || setLlmConfig.isPending || deleteLlmConfig.isPending}>
              {(setLlmConfig.isPending || deleteLlmConfig.isPending) && <Loader2Icon className="animate-spin" />}
              {selection === "nexus" ? "Switch to Nexus-managed" : "Save"}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
