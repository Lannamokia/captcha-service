import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Database,
  FileImage,
  Fingerprint,
  FlaskConical,
  Gauge,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  ScanLine,
  ServerCog,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Type,
  X,
} from "lucide-react";
import { api, ApiError } from "../api";
import { generateTextChallenges, sha256Base64Url, signedRequestHeaders } from "./credential-tools";
import { AssetWorkshop } from "./AssetWorkshop";

type View = "sites" | "assets" | "workshop" | "credentials" | "status";
type Site = {
  id: string;
  name: string;
  allowedOrigins: string[];
  adminOrigin: string;
  effectiveAllowedOrigins: string[];
  active: boolean;
  createdAt?: string;
};
type ChallengeAsset = { id: string; kind: "text_wordlist" | "slider_background"; label: string; payload: string; active: boolean; created_at: string };
type SecurityEvent = { id: string; action: string; site_id?: string | null; created_at: string };
type Status = { status: string; database: string; redis: string; sites: number; sessions24h: number; completed24h: number; recentEvents: SecurityEvent[] };
type TestMode = "text" | "slider";
type TestPhase = "idle" | "signing" | "waiting" | "ready" | "challenging" | "redeeming" | "completed" | "error";
type ScoreDeduction = { factor: string; points: number };
type TestSession = {
  iframeUrl: string;
  allowedOrigin: string;
  sessionRef: string;
  expiresAt: string;
  siteId: string;
  mode: TestMode;
  signingSecret: string;
};

const scoreFactorLabels: Record<string, string> = {
  wasm_unavailable: "WebAssembly 不可用",
  webdriver: "检测到自动化驱动",
  plugins_empty: "浏览器插件列表为空",
  languages_empty: "语言列表为空",
  hardware_concurrency_missing: "处理器并发信息缺失",
  touch_points_invalid: "触点数据异常",
  visibility_changes_high: "页面可见性频繁变化",
  elapsed_too_fast: "环境采集耗时过短",
  audio_fingerprint_unavailable: "音频指纹不可用",
  webgl_fingerprint_unavailable: "WebGL 指纹不可用",
  canvas_fingerprint_unavailable: "Canvas 指纹不可用",
  wasm_report_invalid: "WASM 风控报告无效",
  wasm_score_mismatch: "WASM 与服务端评分不一致",
  integrity_challenge_failed: "动态完整性挑战失败",
  fingerprint_account_churn: "同一机器关联账号过多",
  fingerprint_failure_history: "同一机器近期失败过多",
};

const phaseLabels: Record<TestPhase, string> = {
  idle: "等待测试",
  signing: "正在签名",
  waiting: "正在载入组件",
  ready: "组件已就绪",
  challenging: "验证进行中",
  redeeming: "正在兑换凭证",
  completed: "协议验证通过",
  error: "测试失败",
};

export function AdminApp() {
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [token, setToken] = useState(() => sessionStorage.getItem("captcha-admin-token") || "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ initialized: boolean }>("/admin-api/setup/status")
      .then((value) => setInitialized(value.initialized))
      .catch(() => setInitialized(false));
  }, []);

  async function authenticate() {
    setBusy(true);
    setError("");
    try {
      const path = initialized ? "/admin-api/login" : "/admin-api/setup";
      const result = await api<{ token: string }>(path, { method: "POST", body: JSON.stringify({ username, password }) });
      sessionStorage.setItem("captcha-admin-token", result.token);
      setToken(result.token);
      setInitialized(true);
      setPassword("");
    } catch (requestError) {
      setError(requestError instanceof ApiError && requestError.code === "INVALID_CREDENTIALS" ? "账号或密码错误" : "操作失败，请检查输入");
    } finally {
      setBusy(false);
    }
  }

  if (initialized === null) return <div className="admin-loading"><LoaderCircle className="spin" /><span>载入控制台</span></div>;
  if (!token) {
    return (
      <main className="auth-shell">
        <section className="auth-panel">
          <div className="console-brand"><span><ShieldCheck /></span><div><strong>Captcha Console</strong><small>CONTROL PLANE / V1</small></div></div>
          <div className="auth-heading">
            <span className="section-index">{initialized ? "01" : "00"}</span>
            <h1>{initialized ? "管理员登录" : "初始化管理员"}</h1>
          </div>
          <label>用户名<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label>密码<input type="password" autoComplete={initialized ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" disabled={busy || username.length < 3 || password.length < (initialized ? 1 : 12)} onClick={() => void authenticate()}>
            {busy ? <LoaderCircle size={17} className="spin" /> : <LockKeyhole size={17} />}
            {initialized ? "登录" : "创建管理员"}
          </button>
        </section>
        <aside className="auth-status"><span>ISOLATED SERVICE</span><b>4100</b><small>LISTEN PORT</small></aside>
      </main>
    );
  }

  return <Console token={token} onLogout={() => { sessionStorage.removeItem("captcha-admin-token"); setToken(""); }} />;
}

function Console({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [view, setView] = useState<View>("sites");
  const [sites, setSites] = useState<Site[]>([]);
  const [assets, setAssets] = useState<ChallengeAsset[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [dialog, setDialog] = useState(false);
  const [editingSiteId, setEditingSiteId] = useState("");
  const [name, setName] = useState("");
  const [origins, setOrigins] = useState("");
  const [secret, setSecret] = useState("");
  const [assetDialog, setAssetDialog] = useState(false);
  const [editingAssetId, setEditingAssetId] = useState("");
  const [assetKind, setAssetKind] = useState<ChallengeAsset["kind"]>("text_wordlist");
  const [assetLabel, setAssetLabel] = useState("");
  const [assetPayload, setAssetPayload] = useState("");
  const [copied, setCopied] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [actionError, setActionError] = useState("");
  const [rotateTarget, setRotateTarget] = useState<Site | null>(null);
  const [rotationAcknowledged, setRotationAcknowledged] = useState(false);

  const [testSiteId, setTestSiteId] = useState("");
  const [testSecret, setTestSecret] = useState("");
  const [testMode, setTestMode] = useState<TestMode>("text");
  const [testPhase, setTestPhase] = useState<TestPhase>("idle");
  const [testSession, setTestSession] = useState<TestSession | null>(null);
  const [testScore, setTestScore] = useState<number | null>(null);
  const [testDeductions, setTestDeductions] = useState<ScoreDeduction[]>([]);
  const [testFingerprint, setTestFingerprint] = useState("");
  const [testFingerprintVersion, setTestFingerprintVersion] = useState<number | null>(null);
  const [testFingerprintCapabilities, setTestFingerprintCapabilities] = useState(0);
  const [testIntegrityVerified, setTestIntegrityVerified] = useState<boolean | null>(null);
  const [testError, setTestError] = useState("");
  const [iframeHeight, setIframeHeight] = useState(260);
  const [coverage, setCoverage] = useState<Record<TestMode, boolean>>({ text: false, slider: false });
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const redeemingRef = useRef(false);

  const successRate = useMemo(() => status?.sessions24h ? Math.round((status.completed24h / status.sessions24h) * 100) : 0, [status]);
  const selectedTestSite = sites.find((site) => site.id === testSiteId);
  const editingSite = sites.find((site) => site.id === editingSiteId);
  const assetEntryCount = assetPayload.split(/\r?\n/).filter(Boolean).length;

  async function refresh() {
    try {
      const [siteResult, statusResult, assetResult] = await Promise.all([
        api<Site[]>("/admin-api/sites", {}, token),
        api<Status>("/admin-api/status", {}, token),
        api<ChallengeAsset[]>("/admin-api/assets", {}, token),
      ]);
      setSites(siteResult);
      setStatus(statusResult);
      setAssets(assetResult);
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 401) onLogout();
    }
  }

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!testSiteId && sites.length) setTestSiteId(sites.find((site) => site.active)?.id || sites[0].id);
  }, [sites, testSiteId]);

  useEffect(() => {
    if (!testSession) return;
    const receiveMessage = (event: MessageEvent) => {
      if (event.origin !== testSession.allowedOrigin || event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || data.protocolVersion !== 1 || data.sessionId !== testSession.sessionRef || typeof data.event !== "string") return;
      if (data.event === "captcha.ready") {
        setTestPhase("ready");
        return;
      }
      if (data.event === "captcha.resize" && typeof data.height === "number") {
        setIframeHeight(Math.max(210, Math.min(480, Math.ceil(data.height))));
        return;
      }
      if (data.event === "captcha.evaluated") {
        if (typeof data.score === "number") setTestScore(Math.max(0, Math.min(100, Math.round(data.score))));
        if (Array.isArray(data.deductions)) {
          setTestDeductions(data.deductions.filter((item): item is ScoreDeduction => (
            typeof item === "object" && item !== null && typeof item.factor === "string" && typeof item.points === "number"
          )));
        }
        if (typeof data.machineFingerprint === "string") setTestFingerprint(data.machineFingerprint);
        if (typeof data.fingerprintVersion === "number") setTestFingerprintVersion(data.fingerprintVersion);
        if (typeof data.fingerprintCapabilities === "number") setTestFingerprintCapabilities(data.fingerprintCapabilities);
        if (typeof data.wasmIntegrityVerified === "boolean") setTestIntegrityVerified(data.wasmIntegrityVerified);
        setTestPhase("challenging");
        return;
      }
      if (data.event === "captcha.completed" && typeof data.token === "string" && !redeemingRef.current) {
        redeemingRef.current = true;
        setTestPhase("redeeming");
        void (async () => {
          try {
            const path = "/v1/verifications/redeem";
            const body = JSON.stringify({ sessionRef: testSession.sessionRef, token: data.token });
            const headers = await signedRequestHeaders(testSession.siteId, testSession.signingSecret, "POST", path, body);
            await api<{ success: boolean }>(path, { method: "POST", body, headers });
            setCoverage((current) => ({ ...current, [testSession.mode]: true }));
            setTestPhase("completed");
          } catch (requestError) {
            setTestError(credentialErrorMessage(requestError));
            setTestPhase("error");
          }
        })();
        return;
      }
      if (data.event === "captcha.expired" || data.event === "captcha.error") {
        setTestError(data.event === "captcha.expired" ? "测试会话已过期" : "嵌入组件报告验证错误");
        setTestPhase("error");
      }
    };
    window.addEventListener("message", receiveMessage);
    return () => window.removeEventListener("message", receiveMessage);
  }, [testSession]);

  function openSite(site?: Site) {
    setEditingSiteId(site?.id || "");
    setName(site?.name || "");
    setOrigins(site?.allowedOrigins.join("\n") || "");
    setSecret("");
    setCopied(false);
    setActionError("");
    setDialog(true);
  }

  async function saveSite() {
    const allowedOrigins = origins.split(/[,\n]/).map((value) => value.trim()).filter(Boolean);
    setActionError("");
    try {
      if (editingSiteId) {
        const updated = await api<Site>(`/admin-api/sites/${editingSiteId}`, {
          method: "PUT",
          body: JSON.stringify({ name, allowedOrigins }),
        }, token);
        setSites((current) => current.map((site) => site.id === updated.id ? updated : site));
        setDialog(false);
      } else {
        const result = await api<{ site: Site; secret: string }>("/admin-api/sites", {
          method: "POST",
          body: JSON.stringify({ name, allowedOrigins }),
        }, token);
        setSecret(result.secret);
        setSites((current) => [result.site, ...current]);
      }
      setName("");
      setOrigins("");
    } catch {
      setActionError("站点配置未保存，请检查名称与来源格式");
    }
  }

  async function toggleSite(site: Site) {
    setBusyId(site.id);
    try {
      const updated = await api<Site>(`/admin-api/sites/${site.id}`, { method: "PUT", body: JSON.stringify({ active: !site.active }) }, token);
      setSites((current) => current.map((item) => item.id === site.id ? updated : item));
    } finally {
      setBusyId("");
    }
  }

  async function rotate() {
    if (!rotateTarget) return;
    const site = rotateTarget;
    setBusyId(site.id);
    setActionError("");
    try {
      const result = await api<{ secret: string }>(`/admin-api/sites/${site.id}/rotate-secret`, { method: "POST", body: "{}" }, token);
      setRotateTarget(null);
      setRotationAcknowledged(false);
      setEditingSiteId(site.id);
      setSecret(result.secret);
      setCopied(false);
      setDialog(true);
    } catch {
      setActionError("密钥轮换失败，原密钥保持不变");
    } finally {
      setBusyId("");
    }
  }

  function openAsset(asset?: ChallengeAsset) {
    setEditingAssetId(asset?.id || "");
    setAssetKind(asset?.kind || "text_wordlist");
    setAssetLabel(asset?.label || "");
    setAssetPayload(asset?.payload || "");
    setActionError("");
    setAssetDialog(true);
  }

  async function saveAsset() {
    const payload = { label: assetLabel, payload: assetPayload, ...(!editingAssetId ? { kind: assetKind } : {}) };
    setActionError("");
    try {
      if (editingAssetId) {
        const updated = await api<ChallengeAsset>(`/admin-api/assets/${editingAssetId}`, { method: "PUT", body: JSON.stringify(payload) }, token);
        setAssets((current) => current.map((asset) => asset.id === updated.id ? updated : asset));
      } else {
        const created = await api<ChallengeAsset>("/admin-api/assets", { method: "POST", body: JSON.stringify(payload) }, token);
        setAssets((current) => [created, ...current]);
      }
      setAssetDialog(false);
    } catch {
      setActionError("资产未保存，请检查题目格式或图片大小");
    }
  }

  async function toggleAsset(asset: ChallengeAsset) {
    setBusyId(asset.id);
    try {
      const updated = await api<ChallengeAsset>(`/admin-api/assets/${asset.id}`, { method: "PUT", body: JSON.stringify({ active: !asset.active }) }, token);
      setAssets((current) => current.map((item) => item.id === asset.id ? updated : item));
    } finally {
      setBusyId("");
    }
  }

  function readSliderImage(file?: File) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setAssetPayload(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(file);
  }

  function resetCredentialTest() {
    setTestSession(null);
    setTestPhase("idle");
    setTestScore(null);
    setTestDeductions([]);
    setTestFingerprint("");
    setTestFingerprintVersion(null);
    setTestFingerprintCapabilities(0);
    setTestIntegrityVerified(null);
    setTestError("");
    setIframeHeight(260);
    redeemingRef.current = false;
  }

  async function startCredentialTest() {
    if (!selectedTestSite || !testSecret) return;
    resetCredentialTest();
    setTestPhase("signing");
    try {
      const path = `/admin-api/test/sites/${selectedTestSite.id}/sessions`;
      const body = JSON.stringify({
        usernameDigest: await sha256Base64Url(`captcha-console-test:${crypto.randomUUID()}`),
        action: "login",
        parentOrigin: window.location.origin,
        policyVersion: 1,
        level: "high",
        credentialFailure: false,
        theme: "light",
        brandColor: "#147d92",
        challengeType: testMode,
      });
      const headers = await signedRequestHeaders(selectedTestSite.id, testSecret, "POST", path, body);
      const result = await api<Omit<TestSession, "siteId" | "mode" | "signingSecret">>(path, { method: "POST", body, headers }, token);
      if (new URL(result.iframeUrl).origin !== result.allowedOrigin) throw new Error("ORIGIN_MISMATCH");
      setTestSession({ ...result, siteId: selectedTestSite.id, mode: testMode, signingSecret: testSecret });
      setTestPhase("waiting");
    } catch (requestError) {
      setTestError(credentialErrorMessage(requestError));
      setTestPhase("error");
    }
  }

  const title = view === "sites" ? "接入站点" : view === "assets" ? "挑战资产" : view === "workshop" ? "图片工坊" : view === "credentials" ? "密钥测试" : "运行状态";
  const eyebrow = view === "sites" ? "SITE REGISTRY" : view === "assets" ? "CHALLENGE LIBRARY" : view === "workshop" ? "LOCAL IMAGE PIPELINE" : view === "credentials" ? "CREDENTIAL LAB" : "SERVICE TELEMETRY";

  return (
    <main className="console-shell">
      <header className="topbar">
        <div className="console-brand compact"><span><ShieldCheck /></span><div><strong>Captcha Console</strong><small>CONTROL PLANE / V1</small></div></div>
        <div className="topbar-actions">
          <span className="service-state"><i /> {status?.status === "healthy" ? "服务正常" : "状态未知"}</span>
          <button className="icon-button" title="刷新" onClick={() => void refresh()}><RefreshCw size={17} /></button>
          <button className="icon-button danger" title="退出" onClick={onLogout}><LogOut size={17} /></button>
        </div>
      </header>

      <div className="console-grid">
        <aside className="console-nav">
          <button className={view === "sites" ? "active" : ""} onClick={() => setView("sites")}><ServerCog size={18} /> 接入站点</button>
          <button className={view === "assets" ? "active" : ""} onClick={() => setView("assets")}><FileImage size={18} /> 挑战资产</button>
          <button className={view === "workshop" ? "active" : ""} onClick={() => setView("workshop")}><ScanLine size={18} /> 图片工坊</button>
          <button className={view === "credentials" ? "active" : ""} onClick={() => setView("credentials")}><FlaskConical size={18} /> 密钥测试</button>
          <button className={view === "status" ? "active" : ""} onClick={() => setView("status")}><Activity size={18} /> 运行状态</button>
          <div className="nav-meta"><span>BUILD</span><b>1.0.0</b></div>
        </aside>

        <section className="console-content">
          <div className="page-title">
            <div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1></div>
            {view === "sites" && <button className="primary-button" onClick={() => openSite()}><Plus size={17} /> 新建站点</button>}
            {view === "assets" && <button className="primary-button" onClick={() => openAsset()}><Plus size={17} /> 新建资产</button>}
            {view === "credentials" && testSession && <button className="secondary-button" onClick={resetCredentialTest}><RotateCcw size={17} /> 重置测试</button>}
            {view === "status" && <button className="secondary-button" onClick={() => void refresh()}><RefreshCw size={17} /> 刷新状态</button>}
          </div>

          {view === "sites" && <div className="data-panel">
            <div className="table-header"><span>站点</span><span>信任嵌入来源</span><span>状态</span><span>操作</span></div>
            {sites.length === 0 && <div className="empty-state"><ServerCog /><span>暂无接入站点</span></div>}
            {sites.map((site) => (
              <div className="site-row" key={site.id}>
                <div className="site-name"><strong>{site.name}</strong><code>{site.id}</code></div>
                <div className="origin-list">
                  {site.allowedOrigins.map((origin) => <code key={origin}>{origin}</code>)}
                  <code className="implicit-origin">{site.adminOrigin}<span>后台内置</span></code>
                </div>
                <button className={`state-toggle ${site.active ? "on" : "off"}`} disabled={busyId === site.id} onClick={() => void toggleSite(site)}><i />{site.active ? "启用" : "停用"}</button>
                <div className="row-actions">
                  <button className="icon-button compact" title="编辑" disabled={busyId === site.id} onClick={() => openSite(site)}><Pencil size={15} /></button>
                  <button className="secondary-button small" disabled={busyId === site.id} onClick={() => { setRotateTarget(site); setRotationAcknowledged(false); setActionError(""); }}><KeyRound size={15} /> 轮换密钥</button>
                </div>
              </div>
            ))}
          </div>}

          {view === "assets" && <div className="data-panel">
            <div className="asset-table-header"><span>资产</span><span>预览</span><span>状态</span><span>操作</span></div>
            {assets.length === 0 && <div className="empty-state"><FileImage /><span>暂无挑战资产</span></div>}
            {assets.map((asset) => (
              <div className="asset-row" key={asset.id}>
                <div className="site-name"><strong>{asset.label}</strong><code>{asset.kind === "text_wordlist" ? "字母数字题库" : "滑块背景"}</code></div>
                <div className="asset-preview">
                  {asset.kind === "slider_background" ? <img src={asset.payload} alt="滑块背景预览" /> : <code>{asset.payload.split(/\r?\n/).filter(Boolean).length} 条题目</code>}
                </div>
                <button className={`state-toggle ${asset.active ? "on" : "off"}`} disabled={busyId === asset.id} onClick={() => void toggleAsset(asset)}><i />{asset.active ? "启用" : "停用"}</button>
                <button className="secondary-button small" onClick={() => openAsset(asset)}><Pencil size={15} /> 编辑</button>
              </div>
            ))}
          </div>}

          {view === "workshop" && <AssetWorkshop token={token} onUploaded={refresh} />}

          {view === "credentials" && (
            <div className="credential-workspace">
              <section className="credential-controls">
                <div className="coverage-strip">
                  <CoverageItem icon={<Type />} label="文字辨认" complete={coverage.text} />
                  <CoverageItem icon={<SlidersHorizontal />} label="图形滑块" complete={coverage.slider} />
                </div>
                <label>接入站点
                  <select value={testSiteId} onChange={(event) => { setTestSiteId(event.target.value); setTestSecret(""); setCoverage({ text: false, slider: false }); resetCredentialTest(); }}>
                    {sites.map((site) => <option key={site.id} value={site.id}>{site.name}{site.active ? "" : "（已停用）"}</option>)}
                  </select>
                </label>
                <label>站点密钥
                  <input type="password" autoComplete="off" placeholder="输入待验证的密钥" value={testSecret} onChange={(event) => { setTestSecret(event.target.value); setCoverage({ text: false, slider: false }); resetCredentialTest(); }} />
                </label>
                <fieldset className="mode-fieldset">
                  <legend>验证模式</legend>
                  <div className="segmented-control">
                    <button className={testMode === "text" ? "active" : ""} onClick={() => { setTestMode("text"); resetCredentialTest(); }}><Type size={16} /> 文字辨认</button>
                    <button className={testMode === "slider" ? "active" : ""} onClick={() => { setTestMode("slider"); resetCredentialTest(); }}><SlidersHorizontal size={16} /> 图形滑块</button>
                  </div>
                </fieldset>
                <button className="primary-button test-start" disabled={!selectedTestSite?.active || testSecret.length < 20 || testPhase === "signing" || testPhase === "redeeming"} onClick={() => void startCredentialTest()}>
                  {testPhase === "signing" ? <LoaderCircle size={17} className="spin" /> : <FlaskConical size={17} />}
                  创建测试会话
                </button>
                {testError && <p className="test-error"><ShieldAlert size={16} />{testError}</p>}
              </section>

              <section className="credential-stage">
                <div className={`test-state state-${testPhase}`}><i />{phaseLabels[testPhase]}</div>
                {testSession ? (
                  <div className="test-frame-shell">
                    <iframe
                      key={testSession.sessionRef}
                      ref={iframeRef}
                      src={testSession.iframeUrl}
                      title={`${testSession.mode === "text" ? "文字辨认" : "图形滑块"}测试组件`}
                      style={{ height: iframeHeight }}
                    />
                  </div>
                ) : (
                  <div className="test-placeholder"><FlaskConical /><span>尚未创建测试会话</span></div>
                )}
              </section>

              <aside className="score-panel">
                <div className="score-heading"><span><Gauge size={18} /> 浏览器可信评分</span><strong>{testScore === null ? "--" : testScore}<small>/100</small></strong></div>
                <div className="score-track" aria-label="浏览器可信评分"><i style={{ width: `${testScore || 0}%` }} /></div>
                <div className="score-verdict">{testScore === null ? "等待环境采集" : testScore >= 80 ? "环境可信" : testScore >= 60 ? "需要关注" : "高风险环境"}</div>
                <div className="fingerprint-report">
                  <div className="fingerprint-heading"><span><Fingerprint size={16} /> 站点机器指纹</span><b className={testIntegrityVerified ? "verified" : "unverified"}>{testIntegrityVerified === null ? "等待" : testIntegrityVerified ? "挑战通过" : "挑战失败"}</b></div>
                  <code>{testFingerprint || "--"}</code>
                  <div className="fingerprint-meta"><span>WASM v{testFingerprintVersion ?? "--"}</span><span>{[
                    testFingerprintCapabilities & 1 ? "AUDIO" : null,
                    testFingerprintCapabilities & 2 ? "WEBGL" : null,
                    testFingerprintCapabilities & 4 ? "CANVAS" : null,
                  ].filter(Boolean).join(" / ") || "NO SIGNAL"}</span></div>
                </div>
                <div className="deduction-list">
                  <span className="eyebrow">SCORE BREAKDOWN</span>
                  {testScore !== null && testDeductions.length === 0 && <div className="deduction-ok"><CheckCircle2 size={15} /> 未触发扣分项</div>}
                  {testDeductions.map((item) => <div className="deduction-item" key={item.factor}><span>{scoreFactorLabels[item.factor] || item.factor}</span><b>-{item.points}</b></div>)}
                </div>
              </aside>
            </div>
          )}

          {view === "status" && <>
            <div className="metric-strip">
              <Metric icon={<Database />} label="PostgreSQL" value={status?.database === "healthy" ? "UP" : "DOWN"} />
              <Metric icon={<Activity />} label="Redis" value={status?.redis === "healthy" ? "UP" : "DOWN"} />
              <Metric icon={<Check />} label="24H 完成率" value={`${successRate}%`} />
            </div>
            <div className="data-panel">
              <div className="event-table-header"><span>事件</span><span>站点</span><span>时间</span></div>
              {!status?.recentEvents?.length && <div className="empty-state"><Activity /><span>暂无安全事件</span></div>}
              {status?.recentEvents?.map((event) => <div className="event-row" key={event.id}><strong>{event.action}</strong><code>{event.site_id || "-"}</code><time>{new Date(event.created_at).toLocaleString()}</time></div>)}
            </div>
          </>}
        </section>
      </div>

      {dialog && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!secret) setDialog(false); }}>
          <section className="modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header"><div><span className="eyebrow">SITE CREDENTIAL</span><h2>{secret ? "接入密钥" : editingSiteId ? "编辑站点" : "新建站点"}</h2></div>{!secret && <button className="icon-button" title="关闭" onClick={() => setDialog(false)}><X size={18} /></button>}</div>
            {secret ? (
              <>
                <div className="one-time-warning"><KeyRound size={18} /><span>此密钥仅显示一次</span></div>
                <div className="secret-box"><code>{secret}</code><button className="icon-button" title="复制" onClick={() => { void navigator.clipboard.writeText(secret); setCopied(true); }}>{copied ? <Check size={17} /> : <Copy size={17} />}</button></div>
                <button className="primary-button" onClick={() => { setDialog(false); setSecret(""); setCopied(false); }}>完成</button>
              </>
            ) : (
              <>
                <label>站点名称<input value={name} onChange={(event) => setName(event.target.value)} /></label>
                <label>允许嵌入来源<textarea rows={4} placeholder="https://example.com" value={origins} onChange={(event) => setOrigins(event.target.value)} /></label>
                {editingSite?.adminOrigin && <div className="implicit-origin-note"><ShieldCheck size={16} /><span>管理后台来源 <code>{editingSite.adminOrigin}</code> 已内置信任</span></div>}
                {actionError && <p className="form-error">{actionError}</p>}
                <button className="primary-button" disabled={!name.trim() || !origins.trim()} onClick={() => void saveSite()}>{editingSiteId ? <Check size={17} /> : <Plus size={17} />} {editingSiteId ? "保存站点" : "创建站点"}</button>
              </>
            )}
          </section>
        </div>
      )}

      {assetDialog && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setAssetDialog(false)}>
          <section className="modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header"><div><span className="eyebrow">CHALLENGE ASSET</span><h2>{editingAssetId ? "编辑资产" : "新建资产"}</h2></div><button className="icon-button" title="关闭" onClick={() => setAssetDialog(false)}><X size={18} /></button></div>
            <label>资产名称<input value={assetLabel} onChange={(event) => setAssetLabel(event.target.value)} /></label>
            <label>资产类型<select value={assetKind} disabled={Boolean(editingAssetId)} onChange={(event) => { setAssetKind(event.target.value as ChallengeAsset["kind"]); setAssetPayload(""); }}><option value="text_wordlist">字母数字题库</option><option value="slider_background">滑块背景</option></select></label>
            {assetKind === "text_wordlist" ? (
              <label>六位混合题目
                <div className="asset-generator-row"><span>{assetEntryCount} 条</span><button type="button" className="secondary-button small" onClick={() => setAssetPayload(generateTextChallenges().join("\n"))}><Sparkles size={15} /> 生成 100 条</button></div>
                <textarea rows={9} placeholder={"A2B3C4\nZ9Y8X7\nM4N6P8"} value={assetPayload} onChange={(event) => setAssetPayload(event.target.value.toUpperCase().replace(/[^A-Z0-9\r\n]/g, ""))} />
                <small className="field-hint">每行一组六位大写字母与数字混合题目，自动生成会排除易混淆字符。</small>
              </label>
            ) : (
              <label>背景图片<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => readSliderImage(event.target.files?.[0])} />{assetPayload && <img className="asset-upload-preview" src={assetPayload} alt="待保存的滑块背景" />}<small className="field-hint">PNG、JPEG 或 WebP，建议使用图片工坊裁剪压缩后批量上传。</small></label>
            )}
            {actionError && <p className="form-error">{actionError}</p>}
            <button className="primary-button" disabled={!assetLabel.trim() || !assetPayload.trim()} onClick={() => void saveAsset()}><Check size={17} /> 保存资产</button>
          </section>
        </div>
      )}

      {rotateTarget && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setRotateTarget(null)}>
          <section className="modal destructive-modal" role="alertdialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header"><div><span className="eyebrow danger-text">DESTRUCTIVE ACTION</span><h2>确认轮换站点密钥</h2></div><button className="icon-button" title="关闭" onClick={() => setRotateTarget(null)}><X size={18} /></button></div>
            <div className="rotation-warning"><AlertTriangle size={20} /><div><strong>{rotateTarget.name}</strong><span>轮换后旧密钥立即失效，尚未更新密钥的业务请求会中断。</span></div></div>
            <label className="acknowledge-control"><input type="checkbox" checked={rotationAcknowledged} onChange={(event) => setRotationAcknowledged(event.target.checked)} /><span>我已确认相关接入方可以立即更新密钥</span></label>
            {actionError && <p className="form-error">{actionError}</p>}
            <div className="modal-actions"><button className="secondary-button" onClick={() => setRotateTarget(null)}>取消</button><button className="danger-button" disabled={!rotationAcknowledged || busyId === rotateTarget.id} onClick={() => void rotate()}>{busyId === rotateTarget.id ? <LoaderCircle size={17} className="spin" /> : <KeyRound size={17} />} 确认轮换</button></div>
          </section>
        </div>
      )}
    </main>
  );
}

function credentialErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "INVALID_SIGNATURE") return "密钥或请求签名不正确";
    if (error.code === "ADMIN_ORIGIN_REQUIRED") return "当前后台来源与服务的 PUBLIC_BASE_URL 不一致";
    if (error.code === "NONCE_REPLAY") return "签名随机数已被使用，请重新测试";
    if (error.code === "UNAUTHORIZED") return "管理员会话已失效，请重新登录";
  }
  if (error instanceof Error && error.message === "ORIGIN_MISMATCH") return "组件来源与服务声明不一致";
  return "测试协议未完成，请检查站点状态与密钥";
}

function CoverageItem({ icon, label, complete }: { icon: ReactNode; label: string; complete: boolean }) {
  return <div className={complete ? "coverage-item complete" : "coverage-item"}><span>{icon}</span><div><strong>{label}</strong><small>{complete ? "已通过" : "未测试"}</small></div>{complete && <CheckCircle2 size={17} />}</div>;
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return <div className="metric"><span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div>;
}
