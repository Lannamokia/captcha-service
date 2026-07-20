import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  Check,
  Copy,
  Database,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Plus,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  X,
} from "lucide-react";
import { api, ApiError } from "../api";

type Site = { id: string; name: string; allowedOrigins: string[]; active: boolean; createdAt?: string };
type Status = { status: string; sites: number; sessions24h: number; completed24h: number };

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
  const [sites, setSites] = useState<Site[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [dialog, setDialog] = useState(false);
  const [name, setName] = useState("");
  const [origins, setOrigins] = useState("");
  const [secret, setSecret] = useState("");
  const [copied, setCopied] = useState(false);
  const [busyId, setBusyId] = useState("");
  const successRate = useMemo(() => status?.sessions24h ? Math.round((status.completed24h / status.sessions24h) * 100) : 0, [status]);

  async function refresh() {
    try {
      const [siteResult, statusResult] = await Promise.all([
        api<Site[]>("/admin-api/sites", {}, token),
        api<Status>("/admin-api/status", {}, token),
      ]);
      setSites(siteResult);
      setStatus(statusResult);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onLogout();
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function createSite() {
    const allowedOrigins = origins.split(/[,\n]/).map((value) => value.trim()).filter(Boolean);
    const result = await api<{ site: Site; secret: string }>("/admin-api/sites", {
      method: "POST",
      body: JSON.stringify({ name, allowedOrigins }),
    }, token);
    setSecret(result.secret);
    setSites((current) => [result.site, ...current]);
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

  return (
    <main className="console-shell">
      <header className="topbar">
        <div className="console-brand compact"><span><ShieldCheck /></span><div><strong>Captcha Console</strong><small>CONTROL PLANE / V1</small></div></div>
        <div className="topbar-actions">
          <span className="service-state"><i /> 服务正常</span>
          <button className="icon-button" title="刷新" onClick={() => void refresh()}><RefreshCw size={17} /></button>
          <button className="icon-button danger" title="退出" onClick={onLogout}><LogOut size={17} /></button>
        </div>
      </header>

      <div className="console-grid">
        <aside className="console-nav">
          <button className="active"><ServerCog size={18} /> 接入站点</button>
          <div className="nav-meta"><span>BUILD</span><b>1.0.0</b></div>
        </aside>

        <section className="console-content">
          <div className="page-title">
            <div><span className="eyebrow">SITE REGISTRY</span><h1>接入站点</h1></div>
            <button className="primary-button" onClick={() => { setDialog(true); setSecret(""); }}><Plus size={17} /> 新建站点</button>
          </div>

          <div className="metric-strip">
            <Metric icon={<Database />} label="站点" value={status?.sites ?? 0} />
            <Metric icon={<Activity />} label="24H 会话" value={status?.sessions24h ?? 0} />
            <Metric icon={<Check />} label="完成率" value={`${successRate}%`} />
          </div>

          <div className="data-panel">
            <div className="table-header"><span>站点</span><span>允许来源</span><span>状态</span><span>操作</span></div>
            {sites.length === 0 && <div className="empty-state"><ServerCog /><span>暂无接入站点</span></div>}
            {sites.map((site) => (
              <div className="site-row" key={site.id}>
                <div className="site-name"><strong>{site.name}</strong><code>{site.id}</code></div>
                <div className="origin-list">{site.allowedOrigins.map((origin) => <code key={origin}>{origin}</code>)}</div>
                <button className={`state-toggle ${site.active ? "on" : "off"}`} disabled={busyId === site.id} onClick={() => void toggleSite(site)}><i />{site.active ? "启用" : "停用"}</button>
                <button className="secondary-button small" disabled={busyId === site.id} onClick={() => void rotate(site)}><KeyRound size={15} /> 轮换密钥</button>
              </div>
            ))}
          </div>
        </section>
      </div>

      {dialog && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!secret) setDialog(false); }}>
          <section className="modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header"><div><span className="eyebrow">SITE CREDENTIAL</span><h2>{secret ? "接入密钥" : "新建站点"}</h2></div>{!secret && <button className="icon-button" title="关闭" onClick={() => setDialog(false)}><X size={18} /></button>}</div>
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
                <button className="primary-button" disabled={!name.trim() || !origins.trim()} onClick={() => void createSite()}><Plus size={17} /> 创建站点</button>
              </>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return <div className="metric"><span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div>;
}
