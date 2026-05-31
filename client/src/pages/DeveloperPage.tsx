import React, { useState, useEffect } from "react";
import { useWallets as usePrivyWallets } from "@privy-io/react-auth";
import { AppLayout } from "@/components/AppLayout";
import { WebhookDeliveryLog } from "@/components/WebhookDeliveryLog";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, Label, Input, Button, Skeleton } from "@/components/dashboard-ui";
import { useMerchantProfile, useUpdateWebhook } from "@/hooks/use-merchant";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/components/toast-system";
import { Save, Eye, EyeOff, Copy, Webhook, ChevronDown, ChevronRight, BookOpen, Code2, Send, CheckCircle2, XCircle, Loader2, RefreshCw, ShieldCheck, AlertTriangle, PlugZap } from "lucide-react";
import { fetchApi } from "@/lib/api";
import { useGenerateSeraApiKey, useSeraApiConfig, useTestSeraApiConfig, useUpdateSeraApiConfig } from "@/hooks/use-gateway";
import { AdvancedSelect } from "@/components/AdvancedSelect";
import { DEFAULT_SERA_API_BASE_URL, DEFAULT_SERA_API_TESTNET_BASE_URL, type SeraApiMode } from "@shared/gateway";

export function Developer() {
  const { data: profile, isLoading } = useMerchantProfile();
  const updateWebhook = useUpdateWebhook();
  const { apiKey } = useAuth();
  const { toast } = useToast();

  const [webhookUrl, setWebhookUrl] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; status?: number; body?: string } | null>(null);
  const [testLoading, setTestLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);

  const handleRegenerateSecret = async () => {
    setRegenerating(true);
    setNewSecret(null);
    setSecretCopied(false);
    try {
      const result = await fetchApi("/merchant/webhook/secret/regenerate", { method: "POST" });
      setNewSecret(result.webhookSecret);
      setShowRegenerateConfirm(false);
      toast({ title: "Secret Rotated", description: "Copy and update your server — the old secret is now invalid.", type: "success" });
    } catch (err: any) {
      toast({ title: "Failed", description: err?.message || "Could not regenerate secret", type: "error" });
    } finally {
      setRegenerating(false);
    }
  };

  const copyNewSecret = () => {
    if (!newSecret) return;
    navigator.clipboard.writeText(newSecret);
    setSecretCopied(true);
    setTimeout(() => setSecretCopied(false), 2000);
  };

  const handleTestWebhook = async () => {
    const url = webhookUrl || profile?.webhookUrl;
    if (!url) {
      toast({ title: "No webhook URL", description: "Save a webhook URL first", type: "error" });
      return;
    }
    setTestLoading(true);
    setTestResult(null);
    try {
      const result = await fetchApi("/merchant/webhook/test", {
        method: "POST",
        body: JSON.stringify({ webhookUrl: url }),
      });
      const displayBody = [
        result.payload ? `// Sample payload sent:\n${JSON.stringify(result.payload, null, 2)}` : "",
        result.responseBody ? `\n// Your server responded:\n${result.responseBody}` : "",
      ].filter(Boolean).join("");
      setTestResult({ ok: result.success, status: result.statusCode, body: displayBody || JSON.stringify(result, null, 2) });
    } catch (err: any) {
      setTestResult({ ok: false, body: err?.message || "Request failed" });
    } finally {
      setTestLoading(false);
    }
  };

  useEffect(() => {
    if (profile) setWebhookUrl(profile.webhookUrl || "");
  }, [profile]);

  const handleSaveWebhook = (e: React.FormEvent) => {
    e.preventDefault();
    if (webhookUrl && !webhookUrl.startsWith("https://")) {
      toast({ title: "Invalid URL", description: "Webhook must use HTTPS", type: "error" });
      return;
    }
    updateWebhook.mutate({ webhookUrl }, {
      onSuccess: () => toast({ title: "Webhook Updated", type: "success" }),
      onError: (err: any) => toast({ title: "Webhook Failed", description: err.message, type: "error" }),
    });
  };

  const copyApiKey = () => {
    if (!apiKey) return;
    navigator.clipboard.writeText(apiKey);
    toast({ title: "API Key Copied", type: "success" });
  };

  return (
    <AppLayout>
      <div className="space-y-6 max-w-2xl">
        <div>
          <h1 className="text-xl font-semibold tracking-tight mb-0.5">Developer</h1>
          <p className="text-muted-foreground text-sm">API access, webhook integration, and reference docs</p>
        </div>

        <SeraApiManagedCard />

        {/* Webhook */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2 mb-0.5">
              <Webhook className="w-4 h-4 text-[#00D1A0]" />
              <CardTitle>Webhook</CardTitle>
            </div>
            <CardDescription>Receive HTTPS POST notifications for successful payments.</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-20 w-full" /> : (
              <form onSubmit={handleSaveWebhook} className="space-y-4">
                <div className="space-y-1.5">
                  <Label>Endpoint URL</Label>
                  <Input
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    placeholder="https://your-server.com/webhook"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="submit"
                    disabled={updateWebhook.isPending}
                    size="sm"
                    className="bg-gradient-to-r from-[#00D1A0] to-[#00B88A] hover:from-[#00C196] hover:to-[#00A87E] text-white border-0"
                  >
                    <Save className="w-3.5 h-3.5 mr-1.5" />
                    {updateWebhook.isPending ? "Saving..." : "Save"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={testLoading || (!webhookUrl && !profile?.webhookUrl)}
                    onClick={handleTestWebhook}
                    title="Send a sample payment.confirmed payload to your webhook URL"
                  >
                    {testLoading ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Send className="w-3.5 h-3.5 mr-1.5" />}
                    {testLoading ? "Sending…" : "Send Test"}
                  </Button>
                </div>

                {/* Test result */}
                {testResult && (
                  <div className={`rounded-lg border p-3 text-xs space-y-1.5 ${
                    testResult.ok ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"
                  }`}>
                    <div className="flex items-center gap-1.5 font-semibold">
                      {testResult.ok
                        ? <><CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /><span className="text-emerald-700">Webhook delivered{testResult.status ? ` — HTTP ${testResult.status}` : ""}</span></>
                        : <><XCircle className="w-3.5 h-3.5 text-red-500" /><span className="text-red-600">Delivery failed</span></>}
                    </div>
                    {testResult.body && (
                      <pre className="font-mono text-[10px] leading-relaxed overflow-x-auto whitespace-pre-wrap break-all text-muted-foreground max-h-32">{testResult.body}</pre>
                    )}
                  </div>
                )}
              </form>
            )}

            {/* Webhook Signing Secret */}
            <div className="border-t border-border pt-4 mt-4 space-y-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-3.5 h-3.5 text-[#00D1A0]" />
                <span className="text-xs font-semibold text-foreground">Signing Secret</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                SeraPay signs every webhook request with an HMAC-SHA256 signature in the
                <code className="font-mono mx-1 text-[11px] bg-muted px-1 py-0.5 rounded">X-SeraPay-Signature</code>
                header. Verify it on your server to confirm authenticity.
              </p>

              {/* New secret reveal box */}
              {newSecret && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-2">
                  <div className="flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                    <p className="text-xs font-semibold text-amber-800">Copy this secret now — it won't be shown again</p>
                  </div>
                  <div className="flex gap-2">
                    <code className="flex-1 font-mono text-[11px] bg-white border border-amber-200 rounded px-2 py-1.5 text-amber-900 break-all">{newSecret}</code>
                    <button
                      type="button"
                      onClick={copyNewSecret}
                      className="shrink-0 flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-md bg-amber-500 hover:bg-amber-600 text-white transition-colors"
                    >
                      {secretCopied ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      {secretCopied ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
              )}

              {/* Confirm or button */}
              {showRegenerateConfirm ? (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 space-y-2">
                  <p className="text-xs text-red-700 font-medium">This will invalidate your current signing secret immediately. Are you sure?</p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleRegenerateSecret}
                      disabled={regenerating}
                      className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md bg-red-500 hover:bg-red-600 text-white transition-colors disabled:opacity-60"
                    >
                      {regenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                      {regenerating ? "Regenerating…" : "Yes, Regenerate"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowRegenerateConfirm(false)}
                      className="text-xs font-medium px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => { setShowRegenerateConfirm(true); setNewSecret(null); }}
                  className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Regenerate Secret
                </button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* API Key */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2 mb-0.5">
              <Code2 className="w-4 h-4 text-[#00D1A0]" />
              <CardTitle>API Key</CardTitle>
            </div>
            <CardDescription>Your secret key for programmatic API access and webhook verification.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label>Secret Key</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    type={showKey ? "text" : "password"}
                    value={apiKey || ""}
                    readOnly
                    className="font-mono text-xs pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <Button variant="outline" size="icon" onClick={copyApiKey}>
                  <Copy className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Webhook Delivery Log */}
        <WebhookDeliveryLog />
        {/* API Documentation */}
        <ApiDocs apiKey={apiKey || "sk_your_api_key"} />
      </div>
    </AppLayout>
  );
}

// ── API Documentation Component ────────────────────────────────────────────

function SeraApiManagedCard() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 mb-0.5">
          <ShieldCheck className="w-4 h-4 text-[#00D1A0]" />
          <CardTitle>Sera API</CardTitle>
        </div>
        <CardDescription>SeraPay uses the platform Sera API connection for rates, tokens, swaps, and settlement.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Managed by SeraPay. Merchants do not need to edit API URLs, credentials, or Sera webhook secrets.
        </div>
      </CardContent>
    </Card>
  );
}

function SeraApiConfigCard() {
  const { data: config, isLoading } = useSeraApiConfig();
  const updateConfig = useUpdateSeraApiConfig();
  const generateSeraApiKey = useGenerateSeraApiKey();
  const testConfig = useTestSeraApiConfig();
  const { wallets } = usePrivyWallets();
  const { toast } = useToast();
  const [seraApiKey, setSeraApiKey] = useState("");
  const [seraApiBaseUrl, setSeraApiBaseUrl] = useState(DEFAULT_SERA_API_BASE_URL);
  const [seraWebhookSecret, setSeraWebhookSecret] = useState("");
  const [mode, setMode] = useState<SeraApiMode>("mock");

  useEffect(() => {
    if (!config) return;
    const nextMode = config.mode || "mock";
    setMode(nextMode);
    setSeraApiBaseUrl(config.seraApiBaseUrl || (nextMode === "test" ? DEFAULT_SERA_API_TESTNET_BASE_URL : DEFAULT_SERA_API_BASE_URL));
  }, [config]);

  const handleModeChange = (value: string) => {
    const nextMode = value as SeraApiMode;
    setMode(nextMode);
    if (nextMode === "test") {
      setSeraApiBaseUrl(DEFAULT_SERA_API_TESTNET_BASE_URL);
    } else if (nextMode === "live") {
      setSeraApiBaseUrl(DEFAULT_SERA_API_BASE_URL);
    }
  };

  const handleSave = (event: React.FormEvent) => {
    event.preventDefault();
    updateConfig.mutate(
      { seraApiKey, seraApiBaseUrl, seraWebhookSecret, mode },
      {
        onSuccess: () => {
          setSeraApiKey("");
          setSeraWebhookSecret("");
          toast({ title: "Sera API config saved", type: "success" });
        },
        onError: (err: any) => toast({ title: "Save failed", description: err.message, type: "error" }),
      }
    );
  };

  const handleTest = () => {
    testConfig.mutate(undefined, {
      onSuccess: (result) => {
        toast({
          title: result.snapshot.healthy ? "Sera API reachable" : "Sera API check failed",
          description: result.verification.message,
          type: result.snapshot.healthy ? "success" : "error",
        });
      },
      onError: (err: any) => toast({ title: "Test failed", description: err.message, type: "error" }),
    });
  };

  const handleGenerateSeraApiKey = async () => {
    const wallet = wallets[0];
    if (!wallet) {
      toast({ title: "Connect a wallet first", description: "Sera API key creation requires a wallet signature.", type: "error" });
      return;
    }

    try {
      const systemResponse = await fetch(`/api/sera/system?mode=${encodeURIComponent(mode)}&baseUrl=${encodeURIComponent(seraApiBaseUrl)}`);
      if (!systemResponse.ok) throw new Error(await systemResponse.text());
      const system = await systemResponse.json() as {
        chainId?: number | null;
        seraAddress?: string | null;
      };

      const owner = wallet.address;
      const chainId = system.chainId ?? 11155111;
      const verifyingContract = system.seraAddress ?? "0xd0fc92d8eF9bE26D7288fCa1D6458f675e72B83a";
      const timestamp = Math.floor(Date.now() / 1000);
      const typedData = {
        domain: {
          name: "Sera",
          version: "1",
          chainId,
          verifyingContract,
        },
        types: {
          ManageApiKey: [
            { name: "owner", type: "address" },
            { name: "action", type: "string" },
            { name: "timestamp", type: "uint256" },
          ],
        },
        primaryType: "ManageApiKey",
        message: {
          owner,
          action: "create",
          timestamp,
        },
      };

      const provider = await wallet.getEthereumProvider();
      const request = (provider as { request?: (args: { method: string; params?: unknown[] }) => Promise<unknown> }).request;
      if (!request) throw new Error("Connected wallet does not expose an EIP-1193 provider.");

      await request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${chainId.toString(16)}` }],
      }).catch(() => undefined);

      const signature = await request({
        method: "eth_signTypedData_v4",
        params: [owner, JSON.stringify(typedData)],
      });
      if (typeof signature !== "string") throw new Error("Wallet did not return a signature.");

      const result = await generateSeraApiKey.mutateAsync({
        owner,
        action: "create",
        timestamp,
        signature,
        label: "pay.sera dashboard",
        seraApiBaseUrl,
      });

      setSeraApiKey("");
      setMode(seraApiBaseUrl.toLowerCase().includes("testnet") ? "test" : "live");
      toast({
        title: "Sera API key generated",
        description: result.apiKeyLast4 ? `Saved encrypted key ending ${result.apiKeyLast4}` : result.message,
        type: "success",
      });
    } catch (err: any) {
      toast({ title: "Generation failed", description: err?.message || "Unable to generate Sera API key", type: "error" });
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2 mb-0.5">
          <PlugZap className="w-4 h-4 text-[#00D1A0]" />
          <CardTitle>Sera API Configuration</CardTitle>
        </div>
        <CardDescription>Connect pay.sera to the Sera public API. Leave mock mode on until production credentials are ready.</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-36 w-full" />
        ) : (
          <form onSubmit={handleSave} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>SERA_API_BASE_URL</Label>
                <Input value={seraApiBaseUrl} onChange={(e) => setSeraApiBaseUrl(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Mode</Label>
                <AdvancedSelect
                  value={mode}
                  onValueChange={handleModeChange}
                  options={[
                    { value: "mock", label: "Mock", description: "Use local mocked API responses" },
                    { value: "test", label: "Testnet", description: "Use Sera testnet API and Sepolia flow" },
                    { value: "live", label: "Live", description: "Connect to the Sera public API" },
                  ]}
                  triggerClassName="h-10 rounded-xl"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>SERA_API_KEY</Label>
              <Input
                type="password"
                value={seraApiKey}
                onChange={(e) => setSeraApiKey(e.target.value)}
                placeholder={config?.hasSeraApiKey ? `Saved key ending ${config.seraApiKeyLast4}` : "sera_api_key:sera_api_secret"}
              />
            </div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 leading-relaxed">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p>
                  Generate a Sera API key by signing the documented EIP-712 <span className="font-mono">ManageApiKey</span> message with your connected wallet.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={generateSeraApiKey.isPending || !wallets[0]}
                  onClick={handleGenerateSeraApiKey}
                  className="shrink-0 border-emerald-300 bg-white text-emerald-800 hover:bg-emerald-100"
                >
                  {generateSeraApiKey.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <PlugZap className="w-3.5 h-3.5 mr-1.5" />}
                  Generate with wallet
                </Button>
              </div>
              {!wallets[0] && <p className="mt-2 text-emerald-700">Connect/login with Privy first so the dashboard can request the wallet signature.</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Optional webhook secret</Label>
              <Input
                type="password"
                value={seraWebhookSecret}
                onChange={(e) => setSeraWebhookSecret(e.target.value)}
                placeholder={config?.hasWebhookSecret ? `Saved secret ending ${config.webhookSecretLast4}` : "whsec_..."}
              />
            </div>
            <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground leading-relaxed">
              {config?.encryptionReady
                ? "Secrets are encrypted before persistence."
                : "Set SERA_CONFIG_ENCRYPTION_KEY or SESSION_SECRET before saving live secrets."}
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={updateConfig.isPending} className="bg-[#00D1A0] hover:bg-[#00B88A] text-white">
                <Save className="w-3.5 h-3.5 mr-1.5" />
                {updateConfig.isPending ? "Saving..." : "Save"}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={testConfig.isPending} onClick={handleTest}>
                {testConfig.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
                Test
              </Button>
            </div>
            {testConfig.data && (
              <div className={`rounded-lg border p-3 text-xs ${testConfig.data.snapshot.healthy ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700"}`}>
                <p className="font-semibold">{testConfig.data.snapshot.message}</p>
                <p className="mt-1 text-muted-foreground">
                  Chain {testConfig.data.snapshot.chainId ?? "unknown"} - {testConfig.data.verification.message}
                </p>
              </div>
            )}
          </form>
        )}
      </CardContent>
    </Card>
  );
}

type EndpointDef = {
  method: "GET" | "POST" | "PUT";
  path: string;
  desc: string;
  auth: boolean;
  params?: { name: string; in: "header" | "query" | "body"; type: string; required: boolean; desc: string }[];
  response: string;
};

const ENDPOINTS: EndpointDef[] = [
  {
    method: "POST", path: "/api/merchant/register", desc: "Register or retrieve a merchant account. Idempotent — returns existing account if wallet already registered.", auth: false,
    params: [
      { name: "walletAddress", in: "body", type: "string", required: true, desc: "EVM wallet address (0x...)" },
      { name: "name", in: "body", type: "string", required: false, desc: "Display name for the store" },
      { name: "webhookUrl", in: "body", type: "string", required: false, desc: "HTTPS webhook endpoint" },
    ],
    response: `{ "id": 1, "walletAddress": "0x...", "name": "My Store", "apiKey": "sk_...", "isNew": true }`,
  },
  {
    method: "GET", path: "/api/merchant/profile", desc: "Get current merchant profile.", auth: true,
    response: `{ "id": 1, "walletAddress": "0x...", "name": "My Store", "webhookUrl": "https://...", "createdAt": "...", "updatedAt": "..." }`,
  },
  {
    method: "PUT", path: "/api/merchant/profile", desc: "Update merchant name or webhook URL.", auth: true,
    params: [
      { name: "name", in: "body", type: "string", required: false, desc: "New store name" },
      { name: "webhookUrl", in: "body", type: "string", required: false, desc: "New HTTPS webhook URL" },
    ],
    response: `{ "id": 1, "walletAddress": "0x...", "name": "New Name", "webhookUrl": "https://...", "updatedAt": "..." }`,
  },
  {
    method: "POST", path: "/api/merchant/webhook", desc: "Set or update the webhook endpoint URL (must be HTTPS).", auth: true,
    params: [
      { name: "webhookUrl", in: "body", type: "string", required: true, desc: "HTTPS URL to receive payment events" },
    ],
    response: `{ "success": true, "webhookUrl": "https://your-server.com/webhook" }`,
  },
  {
    method: "GET", path: "/api/merchant/transactions", desc: "List paginated transactions for this merchant.", auth: true,
    params: [
      { name: "limit", in: "query", type: "number", required: false, desc: "Max results (default 50, max 100)" },
      { name: "offset", in: "query", type: "number", required: false, desc: "Pagination offset (default 0)" },
    ],
    response: `{ "transactions": [{ "id": 1, "txHash": "0x...", "from": "0x...", "amount": "98.5", "coin": "USDT", "payCoin": "VGBP", "payAmount": "100.0", "status": "confirmed", "verified": true, "createdAt": "..." }], "pagination": { "limit": 50, "offset": 0 } }`,
  },
  {
    method: "GET", path: "/api/merchant/transactions/:txHash", desc: "Get a single transaction by its on-chain hash.", auth: true,
    response: `{ "id": 1, "txHash": "0x...", "from": "0x...", "to": "0x...", "amount": "98.5", "coin": "USDT", "payCoin": "VGBP", "payAmount": "100.0", "status": "confirmed", "verified": true, "webhookSent": true, "createdAt": "..." }`,
  },
  {
    method: "GET", path: "/api/merchant/stats", desc: "Get aggregate stats and 7-day daily volume chart data.", auth: true,
    response: `{ "totalCount": 100, "confirmedCount": 95, "pendingCount": 3, "unverifiedCount": 2, "totalVolume": "12345.67", "dailyVolume": [{ "date": "2026-01-01", "volume": "1234.56" }] }`,
  },
  {
    method: "GET", path: "/api/wallets", desc: "Get the master wallet and sub-wallet receiving addresses.", auth: true,
    response: `{ "masterWallet": { "type": "master", "address": "0x..." }, "subWallets": [{ "id": "...", "label": "Storefront A", "address": "0x..." }] }`,
  },
  {
    method: "POST", path: "/api/sub-wallets", desc: "Register a merchant-controlled sub-wallet receiving address.", auth: true,
    params: [
      { name: "label", in: "body", type: "string", required: true, desc: "Human-readable label" },
      { name: "address", in: "body", type: "string", required: true, desc: "EVM address controlled by the merchant" },
      { name: "receiveCoin", in: "body", type: "string", required: false, desc: "Preferred receive coin" },
    ],
    response: `{ "id": "...", "label": "Storefront A", "address": "0x...", "status": "active" }`,
  },
  {
    method: "POST", path: "/api/payments", desc: "Create a checkout session/payment link.", auth: true,
    params: [
      { name: "amount", in: "body", type: "string", required: true, desc: "Payment amount" },
      { name: "coin", in: "body", type: "string", required: true, desc: "Receive coin" },
      { name: "subWalletId", in: "body", type: "string", required: false, desc: "Route payment to a sub-wallet" },
    ],
    response: `{ "checkoutUrl": "https://pay.sera.cx/pay/...", "paymentIntent": { "id": "...", "status": "open" } }`,
  },
  {
    method: "GET", path: "/api/payments", desc: "List checkout sessions/payment links.", auth: true,
    response: `{ "paymentIntents": [{ "id": "...", "amount": "10.00", "coin": "USDC", "status": "open", "checkoutUrl": "..." }] }`,
  },
  {
    method: "GET", path: "/api/merchant/events", desc: "Real-time payment event stream (Server-Sent Events). Replays recent successful payments on connect.", auth: true,
    params: [
      { name: "apiKey", in: "query", type: "string", required: true, desc: "Your API key (passed as query param for SSE)" },
      { name: "since", in: "query", type: "string", required: false, desc: "ISO timestamp — replay events after this time" },
    ],
    response: `data: {"event":"connected","merchantId":1}\ndata: {"event":"payment_received","txHash":"0x...","amount":"98.5","coin":"USDT","verified":true}`,
  },
];

const WEBHOOK_PAYLOAD = `{
  "event": "payment_received",
  "transactionId": 1,
  "txHash": "0x...",
  "from": "0x...",
  "to": "0x...",
  "amount": "98.5",
  "coin": "USDT",
  "payCoin": "VGBP",
  "payAmount": "100.0",
  "verified": true,
  "timestamp": "2026-01-01T00:00:00Z"
}`;

const METHOD_COLORS: Record<string, string> = {
  GET: "bg-blue-50 text-blue-700 border-blue-200",
  POST: "bg-emerald-50 text-emerald-700 border-emerald-200",
  PUT: "bg-amber-50 text-amber-700 border-amber-200",
};

function CodeBlock({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div className="relative group mt-1.5">
      <pre className="bg-[#0d1117] text-[#e6edf3] rounded-lg p-3 text-[11px] leading-relaxed overflow-x-auto font-mono whitespace-pre-wrap break-all">
        {children}
      </pre>
      <button
        onClick={copy}
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-[#21262d] hover:bg-[#30363d] text-[#e6edf3] rounded px-2 py-0.5 text-[10px] flex items-center gap-1"
      >
        {copied ? "✓ Copied" : <><Copy className="w-2.5 h-2.5" />Copy</>}
      </button>
    </div>
  );
}

function EndpointRow({ ep, apiKey }: { ep: EndpointDef; apiKey: string }) {
  const [open, setOpen] = useState(false);

  const exampleCurl = ep.method === "GET"
    ? `curl -H "x-api-key: ${apiKey}" \\\n  https://api.serapay.io${ep.path}`
    : `curl -X ${ep.method} \\\n  -H "x-api-key: ${apiKey}" \\\n  -H "Content-Type: application/json" \\\n  -d '{}' \\\n  https://api.serapay.io${ep.path}`;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors text-left"
        onClick={() => setOpen(o => !o)}
      >
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border font-mono shrink-0 ${METHOD_COLORS[ep.method]}`}>
          {ep.method}
        </span>
        <span className="font-mono text-xs text-foreground truncate flex-1">{ep.path}</span>
        {ep.auth && (
          <span className="text-[10px] text-muted-foreground shrink-0 hidden sm:inline">🔑 auth</span>
        )}
        {open ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
      </button>

      {open && (
        <div className="border-t border-border px-4 pb-4 pt-3 space-y-3 bg-muted/10">
          <p className="text-sm text-muted-foreground">{ep.desc}</p>

          {ep.auth && (
            <div className="flex items-center gap-2 text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-md px-3 py-1.5">
              <span>🔑</span>
              <span>Requires <code className="font-mono">x-api-key</code> header</span>
            </div>
          )}

          {ep.params && ep.params.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-foreground mb-1.5">Parameters</p>
              <div className="rounded-md border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/40 border-b border-border">
                      <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Name</th>
                      <th className="text-left px-3 py-1.5 font-medium text-muted-foreground hidden sm:table-cell">In</th>
                      <th className="text-left px-3 py-1.5 font-medium text-muted-foreground hidden sm:table-cell">Type</th>
                      <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ep.params.map((p, i) => (
                      <tr key={i} className={i < ep.params!.length - 1 ? "border-b border-border" : ""}>
                        <td className="px-3 py-1.5">
                          <code className="font-mono text-[11px] text-[#00B88A]">{p.name}</code>
                          {p.required && <span className="ml-1 text-red-500 text-[10px]">*</span>}
                        </td>
                        <td className="px-3 py-1.5 text-muted-foreground hidden sm:table-cell">{p.in}</td>
                        <td className="px-3 py-1.5 text-muted-foreground hidden sm:table-cell font-mono">{p.type}</td>
                        <td className="px-3 py-1.5 text-muted-foreground">{p.desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div>
            <p className="text-xs font-semibold text-foreground mb-1">Example Response</p>
            <CodeBlock>{ep.response}</CodeBlock>
          </div>

          <div>
            <p className="text-xs font-semibold text-foreground mb-1">cURL Example</p>
            <CodeBlock>{exampleCurl}</CodeBlock>
          </div>
        </div>
      )}
    </div>
  );
}

function ApiDocs({ apiKey }: { apiKey: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <CardHeader>
        <button
          type="button"
          className="flex items-center gap-2 w-full text-left"
          onClick={() => setOpen(o => !o)}
        >
          <BookOpen className="w-4 h-4 text-[#00D1A0] shrink-0" />
          <div className="flex-1">
            <CardTitle>API Documentation</CardTitle>
            <CardDescription className="mt-0.5">Complete reference for the SeraPay Merchant API</CardDescription>
          </div>
          {open ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
        </button>
      </CardHeader>

      {open && (
        <CardContent className="pt-0 space-y-5">
          <div className="rounded-lg border border-[#00D1A0]/30 bg-[#00D1A0]/5 p-3.5 space-y-2">
            <p className="text-xs font-semibold text-[#00B88A]">Authentication</p>
            <p className="text-xs text-muted-foreground">All protected endpoints require your API key in the request header:</p>
            <CodeBlock>{`x-api-key: ${apiKey}`}</CodeBlock>
            <p className="text-xs text-muted-foreground">
              For SSE (<code className="font-mono">/api/merchant/events</code>), pass the key as a query param: <code className="font-mono">?apiKey=sk_...</code>
            </p>
          </div>

          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Transaction Status Values</p>
            <div className="grid grid-cols-3 gap-2 text-xs">
              {[
                { s: "pending", c: "bg-yellow-50 border-yellow-200 text-yellow-700", d: "Submitted, awaiting on-chain confirmation" },
                { s: "confirmed", c: "bg-green-50 border-green-200 text-green-700", d: "Verified on Sepolia blockchain" },
                { s: "unverified", c: "bg-red-50 border-red-200 text-red-700", d: "Chain query failed — treat as suspicious" },
              ].map(({ s, c, d }) => (
                <div key={s} className={`rounded-md border px-2 py-1.5 ${c}`}>
                  <p className="font-mono font-semibold text-[11px]">{s}</p>
                  <p className="text-[10px] mt-0.5 opacity-80">{d}</p>
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Endpoints</p>
            <div className="space-y-2">
              {ENDPOINTS.map((ep, i) => (
                <EndpointRow key={i} ep={ep} apiKey={apiKey} />
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold text-foreground mb-1">Webhook POST Payload</p>
            <p className="text-xs text-muted-foreground mb-1.5">
              When a payment is successful on-chain, SeraPay sends a POST to your webhook URL with this JSON body:
            </p>
            <CodeBlock>{WEBHOOK_PAYLOAD}</CodeBlock>
          </div>

          <div className="text-xs text-muted-foreground bg-muted/30 rounded-md px-3 py-2">
            <span className="font-semibold">Base URL:</span> Use the domain where your API server is deployed.
            All endpoints are prefixed with <code className="font-mono">/api</code>.
            Network: <span className="font-semibold text-[#00B88A]">Sepolia Testnet</span>.
          </div>
        </CardContent>
      )}
    </Card>
  );
}
