import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  Check,
  Copy,
  Database,
  FileImage,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  X,
} from "lucide-react";
import { api, ApiError } from "../api";

type Site = { id: string; name: string; allowedOrigins: string[]; active: boolean; createdAt?: string };
type ChallengeAsset = { id: string; kind: "text_wordlist" | "slider_background"; label: string; payload: string; active: boolean; created_at: string };
type SecurityEvent = { id: string; action: string; site_id?: string | null; created_at: string };
type Status = { status: string; database: string; redis: string; sites: number; sessions24h: number; completed24h: number; recentEvents: SecurityEvent[] };

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
    } finally { setBusy(false); }
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
  const [view, setView] = useState<"sites" | "assets" | "status">("sites");
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
  const successRate = useMemo(() => status?.sessions24h ? Math.round((status.completed24h / status.sessions24h) * 100) : 0, [status]);

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
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onLogout();
    }
  }

  useEffect(() => { void refresh(); }, []);

  function openSite(site?: Site) {
    setEditingSiteId(site?.id || "");
    setName(site?.name || "");
    setOrigins(site?.allowedOrigins.join("\n") || "");
    setSecret("");
    setDialog(true);
  }

  async function saveSite() {
    const allowedOrigins = origins.split(/[,\n]/).map((value) => value.trim()).filter(Boolean);
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
  }

  async function toggleSite(site: Site) {
    setBusyId(site.id);
    try {
      const updated = await api<Site>(`/admin-api/sites/${site.id}`, { method: "PUT", body: JSON.stringify({ active: !site.active }) }, token);
      setSites((current) => current.map((item) => item.id === site.id ? updated : item));
    } finally { setBusyId(""); }
  }

  async function rotate(site: Site) {
    setBusyId(site.id);
    try {
      const result = await api<{ secret: string }>(`/admin-api/sites/${site.id}/rotate-secret`, { method: "POST", body: "{}" }, token);
      setSecret(result.secret);
      setDialog(true);
    } finally { setBusyId(""); }
  }

  function openAsset(asset?: ChallengeAsset) {
    setEditingAssetId(asset?.id || "");
    setAssetKind(asset?.kind || "text_wordlist");
    setAssetLabel(asset?.label || "");
    setAssetPayload(asset?.payload || "");
    setAssetDialog(true);
  }

  async function saveAsset() {
    const payload = { label: assetLabel, payload: assetPayload, ...(!editingAssetId ? { kind: assetKind } : {}) };
    if (editingAssetId) {
      const updated = await api<ChallengeAsset>(`/admin-api/assets/${editingAssetId}`, { method: "PUT", body: JSON.stringify(payload) }, token);
      setAssets((current) => current.map((asset) => asset.id === updated.id ? updated : asset));
    } else {
      const created = await api<ChallengeAsset>("/admin-api/assets", { method: "POST", body: JSON.stringify(payload) }, token);
      setAssets((current) => [created, ...current]);
    }
    setAssetDialog(false);
  }

  async function toggleAsset(asset: ChallengeAsset) {
    setBusyId(asset.id);
    try {
      const updated = await api<ChallengeAsset>(`/admin-api/assets/${asset.id}`, { method: "PUT", body: JSON.stringify({ active: !asset.active }) }, token);
      setAssets((current) => current.map((item) => item.id === updated.id ? updated : item));
    } finally { setBusyId(""); }
  }

  function readSliderImage(file?: File) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setAssetPayload(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(file);
  }

  const title = view === "sites" ? "接入站点" : view === "assets" ? "挑战资产" : "运行状态";
  const eyebrow = view === "sites" ? "SITE REGISTRY" : view === "assets" ? "CHALLENGE LIBRARY" : "SERVICE TELEMETRY";

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
          <button className={view === "status" ? "active" : ""} onClick={() => setView("status")}><Activity size={18} /> 运行状态</button>
          <div className="nav-meta"><span>BUILD</span><b>1.0.0</b></div>
        </aside>

        <section className="console-content">
          <div className="page-title">
            <div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1></div>
            {view === "sites" && <button className="primary-button" onClick={() => openSite()}><Plus size={17} /> 新建站点</button>}
            {view === "assets" && <button className="primary-button" onClick={() => openAsset()}><Plus size={17} /> 新建资产</button>}
            {view === "status" && <button className="secondary-button" onClick={() => void refresh()}><RefreshCw size={17} /> 刷新状态</button>}
          </div>

          {view === "sites" && <div className="data-panel">
            <div className="table-header"><span>站点</span><span>允许来源</span><span>状态</span><span>操作</span></div>
            {sites.length === 0 && <div className="empty-state"><ServerCog /><span>暂无接入站点</span></div>}
            {sites.map((site) => (
              <div className="site-row" key={site.id}>
                <div className="site-name"><strong>{site.name}</strong><code>{site.id}</code></div>
                <div className="origin-list">{site.allowedOrigins.map((origin) => <code key={origin}>{origin}</code>)}</div>
                <button className={`state-toggle ${site.active ? "on" : "off"}`} disabled={busyId === site.id} onClick={() => void toggleSite(site)}><i />{site.active ? "启用" : "停用"}</button>
                <div className="row-actions">
                  <button className="icon-button compact" title="编辑" disabled={busyId === site.id} onClick={() => openSite(site)}><Pencil size={15} /></button>
                  <button className="secondary-button small" disabled={busyId === site.id} onClick={() => void rotate(site)}><KeyRound size={15} /> 轮换密钥</button>
                </div>
              </div>
            ))}
          </div>}

          {view === "assets" && <div className="data-panel">
            <div className="asset-table-header"><span>资产</span><span>预览</span><span>状态</span><span>操作</span></div>
            {assets.length === 0 && <div className="empty-state"><FileImage /><span>暂无挑战资产</span></div>}
            {assets.map((asset) => (
              <div className="asset-row" key={asset.id}>
                <div className="site-name"><strong>{asset.label}</strong><code>{asset.kind === "text_wordlist" ? "数字题库" : "滑块背景"}</code></div>
                <div className="asset-preview">
                  {asset.kind === "slider_background" ? <img src={asset.payload} alt="滑块背景预览" /> : <code>{asset.payload.split(/\r?\n/).filter(Boolean).length} 条题目</code>}
                </div>
                <button className={`state-toggle ${asset.active ? "on" : "off"}`} disabled={busyId === asset.id} onClick={() => void toggleAsset(asset)}><i />{asset.active ? "启用" : "停用"}</button>
                <button className="secondary-button small" onClick={() => openAsset(asset)}><Pencil size={15} /> 编辑</button>
              </div>
            ))}
          </div>}

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
                <div className="secret-box"><code>{secret}</code><button className="icon-button" title="复制" onClick={() => { void navigator.clipboard.writeText(secret); setCopied(true); }} >{copied ? <Check size={17} /> : <Copy size={17} />}</button></div>
                <button className="primary-button" onClick={() => { setDialog(false); setSecret(""); setCopied(false); }}>完成</button>
              </>
            ) : (
              <>
                <label>站点名称<input value={name} onChange={(event) => setName(event.target.value)} /></label>
                <label>允许嵌入来源<textarea rows={4} placeholder="https://example.com" value={origins} onChange={(event) => setOrigins(event.target.value)} /></label>
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
            <label>资产类型<select value={assetKind} disabled={Boolean(editingAssetId)} onChange={(event) => { setAssetKind(event.target.value as ChallengeAsset["kind"]); setAssetPayload(""); }}><option value="text_wordlist">数字题库</option><option value="slider_background">滑块背景</option></select></label>
            {assetKind === "text_wordlist" ? (
              <label>六位数字题目<textarea rows={7} placeholder={"482731\n105946\n730218"} value={assetPayload} onChange={(event) => setAssetPayload(event.target.value.replace(/[^\d\r\n]/g, ""))} /><small className="field-hint">每行一个六位数字，启用后随机用于文字验证。</small></label>
            ) : (
              <label>背景图片<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => readSliderImage(event.target.files?.[0])} />{assetPayload && <img className="asset-upload-preview" src={assetPayload} alt="待保存的滑块背景" />}<small className="field-hint">PNG、JPEG 或 WebP，编码后不超过 100 KB。</small></label>
            )}
            <button className="primary-button" disabled={!assetLabel.trim() || !assetPayload.trim()} onClick={() => void saveAsset()}><Check size={17} /> 保存资产</button>
          </section>
        </div>
      )}
    </main>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return <div className="metric"><span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div>;
}
