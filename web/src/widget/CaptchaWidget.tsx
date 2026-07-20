import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { CheckCircle2, LoaderCircle, RefreshCw, ShieldCheck, SlidersHorizontal, Type } from "lucide-react";
import { api } from "../api";

type Bootstrap = {
  sessionId: string;
  parentOrigin: string;
  theme: "light" | "dark";
  brandColor: string;
  expiresAt: string;
  protocolVersion: 1;
};

type Diagnostic = {
  score: number;
  deductions: Array<{ factor: string; points: number }>;
};

type Challenge = (
  | { decision: "text"; imageData: string; parentOrigin: string }
  | { decision: "slider"; backgroundImage: string; pieceImage: string; sliderMax: number; motionMap: number[]; holeCount: number; parentOrigin: string }
) & { diagnostic?: Diagnostic };

type MessageEventName = "captcha.ready" | "captcha.resize" | "captcha.evaluated" | "captcha.completed" | "captcha.expired" | "captcha.error";

export function CaptchaWidget() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const sessionId = params.get("session") || "";
  const tokenRef = useRef(new URLSearchParams(window.location.hash.slice(1)).get("token") || "");
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "text" | "slider" | "complete" | "error">("loading");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [answer, setAnswer] = useState(0);
  const [textAnswer, setTextAnswer] = useState("");
  const [error, setError] = useState("");
  const pointsRef = useRef<Array<{ x: number; y: number; t: number }>>([]);
  const startRef = useRef(0);
  const visibilityChanges = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  function visualSliderPosition(value: number, motionMap: number[]): number {
    if (motionMap.length < 2) return value;
    const clamped = Math.max(0, Math.min(motionMap.length - 1, value));
    const lower = Math.floor(clamped);
    const upper = Math.min(motionMap.length - 1, lower + 1);
    const fraction = clamped - lower;
    return motionMap[lower] + (motionMap[upper] - motionMap[lower]) * fraction;
  }

  const post = useCallback((event: MessageEventName, payload: Record<string, unknown> = {}) => {
    if (!bootstrap) return;
    window.parent.postMessage({ event, protocolVersion: 1, sessionId, ...payload }, bootstrap.parentOrigin);
  }, [bootstrap, sessionId]);

  useEffect(() => {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    const onVisibility = () => { visibilityChanges.current += 1; };
    document.addEventListener("visibilitychange", onVisibility);
    api<Bootstrap>(`/v1/widget/sessions/${sessionId}/bootstrap`, {}, tokenRef.current)
      .then((value) => {
        setBootstrap(value);
        setPhase("idle");
        document.documentElement.dataset.theme = value.theme;
        document.documentElement.style.setProperty("--brand", value.brandColor);
      })
      .catch(() => setPhase("error"));
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [sessionId]);

  useEffect(() => {
    if (!bootstrap) return;
    post("captcha.ready");
    const timeout = window.setTimeout(() => {
      setPhase("error");
      setError("会话已过期");
      post("captcha.expired");
    }, Math.max(0, Date.parse(bootstrap.expiresAt) - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [bootstrap, post]);

  useEffect(() => {
    if (!bootstrap || !rootRef.current) return;
    const observer = new ResizeObserver(([entry]) => post("captcha.resize", { height: Math.ceil(entry.contentRect.height) }));
    observer.observe(rootRef.current);
    return () => observer.disconnect();
  }, [bootstrap, post]);

  async function wasmProbe() {
    try {
      const instance = await WebAssembly.instantiate(new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127,
        3, 2, 1, 0, 7, 7, 1, 3, 97, 100, 100, 0, 0, 10, 9, 1, 7, 0,
        32, 0, 32, 1, 106, 11,
      ]));
      const add = (instance.instance.exports as { add?: (left: number, right: number) => number }).add;
      return add?.(19, 23) === 42;
    } catch { return false; }
  }

  async function evaluate() {
    setPhase("loading");
    setError("");
    const started = performance.now();
    try {
      const result = await api<Challenge | ({ decision: "pass"; completionToken: string; parentOrigin: string } & { diagnostic?: Diagnostic })>(
        `/v1/widget/sessions/${sessionId}/evaluate`,
        {
          method: "POST",
          body: JSON.stringify({
            wasmAvailable: await wasmProbe(),
            webdriver: navigator.webdriver,
            plugins: navigator.plugins.length,
            languages: navigator.languages.length,
            hardwareConcurrency: navigator.hardwareConcurrency || 0,
            touchPoints: navigator.maxTouchPoints || 0,
            visibilityChanges: visibilityChanges.current,
            elapsedMs: performance.now() - started + 180,
          }),
        },
        tokenRef.current
      );
      if (result.diagnostic) {
        post("captcha.evaluated", {
          score: result.diagnostic.score,
          deductions: result.diagnostic.deductions,
          challengeType: result.decision,
        });
      }
      if (result.decision === "pass") {
        setPhase("complete");
        post("captcha.completed", { token: result.completionToken });
      } else {
        setChallenge(result);
        setPhase(result.decision);
        setTextAnswer("");
        setAnswer(0);
        pointsRef.current = [];
      }
    } catch {
      setError("验证服务暂时不可用");
      setPhase("error");
      post("captcha.error", { code: "WIDGET_EVALUATION_FAILED" });
    }
  }

  async function submit() {
    setError("");
    try {
      const result = await api<{ success: boolean; completionToken: string }>(
        `/v1/widget/sessions/${sessionId}/verify`,
        {
          method: "POST",
          body: JSON.stringify({
            answer: phase === "text" ? textAnswer : answer,
            trajectory: phase === "slider" ? pointsRef.current : undefined,
          }),
        },
        tokenRef.current
      );
      setPhase("complete");
      post("captcha.completed", { token: result.completionToken });
    } catch {
      setError("验证未通过，请重试");
    }
  }

  async function fallback() {
    const result = await api<Challenge>(`/v1/widget/sessions/${sessionId}/accessibility-fallback`, { method: "POST", body: "{}" }, tokenRef.current);
    setChallenge(result);
    setPhase("text");
    setError("");
  }

  return (
    <main className="widget-shell" ref={rootRef}>
      <header className="widget-header">
        <span className="widget-mark"><ShieldCheck size={18} /></span>
        <strong>安全验证</strong>
        <span className={`status-dot status-${phase}`} aria-label={phase} />
      </header>

      {phase === "idle" && (
        <button className="primary-button widget-action" onClick={() => void evaluate()}>
          <ShieldCheck size={17} /> 开始验证
        </button>
      )}
      {phase === "loading" && <div className="widget-loading"><LoaderCircle size={22} className="spin" /><span>正在校验</span></div>}
      {phase === "text" && challenge?.decision === "text" && (
        <section className="challenge-block">
          <div className="challenge-label"><Type size={15} /> 图形验证码</div>
          <img className="captcha-image" src={challenge.imageData} alt="验证码图像" />
          <div className="inline-control">
            <input value={textAnswer} autoCapitalize="characters" maxLength={6} aria-label="验证码" onChange={(event) => setTextAnswer(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} />
            <button className="icon-button" title="刷新" aria-label="刷新" onClick={() => void evaluate()}><RefreshCw size={17} /></button>
          </div>
          <button className="primary-button" disabled={textAnswer.length !== 6} onClick={() => void submit()}>提交验证</button>
        </section>
      )}
      {phase === "slider" && challenge?.decision === "slider" && (
        <section className="challenge-block">
          <div className="challenge-label"><SlidersHorizontal size={15} /> 拖动拼图块到匹配缺口</div>
          <div className="slider-scene">
            <img className="slider-background" src={challenge.backgroundImage} alt="拼图验证背景" draggable={false} />
            <img
              className="slider-piece-layer"
              src={challenge.pieceImage}
              alt="待拖动拼图块"
              draggable={false}
              style={{ transform: `translateX(${(visualSliderPosition(answer, challenge.motionMap) / 320) * 100}%)` } as CSSProperties}
            />
          </div>
          <div className="slider-control">
            <span className="slider-arrow" aria-hidden="true">&#8594;</span>
            <input
              className="captcha-slider"
              type="range"
              min={0}
              max={challenge.sliderMax}
              value={answer}
              aria-label="向右拖动拼图块"
              onPointerDown={(event) => {
                startRef.current = performance.now();
                pointsRef.current = [{ x: Number(event.currentTarget.value), y: event.clientY, t: 0 }];
              }}
              onPointerMove={(event) => {
                if (!event.buttons) return;
                pointsRef.current.push({ x: Number(event.currentTarget.value), y: event.clientY, t: performance.now() - startRef.current });
              }}
              onPointerUp={(event) => {
                pointsRef.current.push({ x: Number(event.currentTarget.value), y: event.clientY, t: performance.now() - startRef.current });
              }}
              onChange={(event) => setAnswer(Number(event.target.value))}
            />
          </div>
          <div className="widget-actions">
            <button className="link-button" onClick={() => void fallback()}>文字验证</button>
            <button className="primary-button" onClick={() => void submit()}>提交验证</button>
          </div>
        </section>
      )}
      {phase === "complete" && <div className="widget-complete"><CheckCircle2 size={25} /><strong>验证完成</strong></div>}
      {phase === "error" && <button className="secondary-button widget-action" onClick={() => void evaluate()}><RefreshCw size={17} /> 重试</button>}
      {error && <p className="inline-error" role="alert">{error}</p>}

      <footer className="widget-footer"><span>CAPTCHA SERVICE</span><span>v1</span></footer>
    </main>
  );
}
