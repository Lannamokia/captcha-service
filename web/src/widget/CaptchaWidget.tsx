import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { CheckCircle2, LoaderCircle, RefreshCw, ShieldCheck, SlidersHorizontal, Type } from "lucide-react";
import { ApiError, api } from "../api";
import { collectBrowserRisk, type IntegrityChallenge } from "./browser-risk";

type Bootstrap = {
  sessionId: string;
  parentOrigin: string;
  theme: "light" | "dark";
  brandColor: string;
  expiresAt: string;
  protocolVersion: 1;
  fingerprintSalt: string;
  integrityChallenge: IntegrityChallenge;
};

type Diagnostic = {
  score: number;
  deductions: Array<{ factor: string; points: number }>;
  machineFingerprint?: string;
  fingerprintVersion?: number;
  fingerprintCapabilities?: number;
  wasmIntegrityVerified?: boolean;
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
  const draggingPointerRef = useRef<number | null>(null);
  const sliderSubmittingRef = useRef(false);
  const visibilityChanges = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const [sliderSubmitting, setSliderSubmitting] = useState(false);

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

  async function evaluate(trustedActivation = false) {
    setPhase("loading");
    setError("");
    const started = performance.now();
    try {
      if (!bootstrap) throw new Error("WIDGET_NOT_READY");
      const currentBootstrap = await api<Bootstrap>(
        `/v1/widget/sessions/${sessionId}/bootstrap`,
        {},
        tokenRef.current,
      );
      setBootstrap(currentBootstrap);
      const browserRisk = await collectBrowserRisk(
        currentBootstrap.fingerprintSalt,
        currentBootstrap.integrityChallenge,
        visibilityChanges.current,
        trustedActivation,
        started,
      );
      const result = await api<Challenge | ({ decision: "pass"; completionToken: string; parentOrigin: string } & { diagnostic?: Diagnostic })>(
        `/v1/widget/sessions/${sessionId}/evaluate`,
        {
          method: "POST",
          body: JSON.stringify(browserRisk),
        },
        tokenRef.current
      );
      if (result.diagnostic) {
        post("captcha.evaluated", {
          score: result.diagnostic.score,
          deductions: result.diagnostic.deductions,
          challengeType: result.decision,
          machineFingerprint: result.diagnostic.machineFingerprint,
          fingerprintVersion: result.diagnostic.fingerprintVersion,
          fingerprintCapabilities: result.diagnostic.fingerprintCapabilities,
          wasmIntegrityVerified: result.diagnostic.wasmIntegrityVerified,
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
        draggingPointerRef.current = null;
        sliderSubmittingRef.current = false;
        setSliderSubmitting(false);
      }
    } catch {
      setError("验证服务暂时不可用");
      setPhase("error");
      post("captcha.error", { code: "WIDGET_EVALUATION_FAILED" });
    }
  }

  async function submit(sliderAttempt?: { answer: number; trajectory: Array<{ x: number; y: number; t: number }> }) {
    const submittingSlider = phase === "slider";
    if (submittingSlider) {
      if (sliderSubmittingRef.current) return;
      sliderSubmittingRef.current = true;
      setSliderSubmitting(true);
    }
    setError("");
    try {
      const result = await api<{ success: boolean; completionToken: string }>(
        `/v1/widget/sessions/${sessionId}/verify`,
        {
          method: "POST",
          body: JSON.stringify({
            answer: phase === "text" ? textAnswer : sliderAttempt?.answer ?? answer,
            trajectory: submittingSlider ? sliderAttempt?.trajectory ?? pointsRef.current : undefined,
          }),
        },
        tokenRef.current
      );
      setPhase("complete");
      post("captcha.completed", { token: result.completionToken });
    } catch (requestError) {
      if (submittingSlider) {
        const retryMap = requestError instanceof ApiError && Array.isArray(requestError.payload.motionMap)
          ? requestError.payload.motionMap.filter((value): value is number => typeof value === "number")
          : null;
        if (retryMap && challenge?.decision === "slider" && retryMap.length === challenge.sliderMax + 1) {
          setChallenge((current) => current?.decision === "slider" ? { ...current, motionMap: retryMap } : current);
        }
        setAnswer(0);
        pointsRef.current = [];
        draggingPointerRef.current = null;
        const attemptsRemaining = requestError instanceof ApiError && typeof requestError.payload.attemptsRemaining === "number"
          ? requestError.payload.attemptsRemaining
          : null;
        setError(attemptsRemaining === 0 ? "尝试次数已用尽" : "验证未通过，请重新拖动");
      } else {
        setError("验证未通过，请重试");
      }
    } finally {
      if (submittingSlider) {
        sliderSubmittingRef.current = false;
        setSliderSubmitting(false);
      }
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
        <button className="primary-button widget-action" onClick={(event) => void evaluate(event.nativeEvent.isTrusted)}>
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
            <button className="icon-button" title="刷新" aria-label="刷新" onClick={(event) => void evaluate(event.nativeEvent.isTrusted)}><RefreshCw size={17} /></button>
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
              disabled={sliderSubmitting}
              aria-busy={sliderSubmitting}
              aria-label="向右拖动拼图块"
              onPointerDown={(event) => {
                if (sliderSubmittingRef.current) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                draggingPointerRef.current = event.pointerId;
                setError("");
                startRef.current = performance.now();
                pointsRef.current = [{ x: Number(event.currentTarget.value), y: event.clientY, t: 0 }];
              }}
              onPointerMove={(event) => {
                if (draggingPointerRef.current !== event.pointerId) return;
                const point = { x: Number(event.currentTarget.value), y: event.clientY, t: performance.now() - startRef.current };
                if (point.t > (pointsRef.current.at(-1)?.t ?? -1)) pointsRef.current.push(point);
              }}
              onPointerUp={(event) => {
                if (draggingPointerRef.current !== event.pointerId) return;
                const releasedAnswer = Number(event.currentTarget.value);
                const finalPoint = { x: releasedAnswer, y: event.clientY, t: performance.now() - startRef.current };
                if (finalPoint.t > (pointsRef.current.at(-1)?.t ?? -1)) pointsRef.current.push(finalPoint);
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                draggingPointerRef.current = null;
                setAnswer(releasedAnswer);
                void submit({ answer: releasedAnswer, trajectory: [...pointsRef.current] });
              }}
              onPointerCancel={(event) => {
                if (draggingPointerRef.current !== event.pointerId) return;
                draggingPointerRef.current = null;
                pointsRef.current = [];
                setAnswer(0);
              }}
              onChange={(event) => setAnswer(Number(event.target.value))}
            />
          </div>
          <div className="widget-actions">
            <button className="link-button" onClick={() => void fallback()}>文字验证</button>
            {sliderSubmitting && <span className="slider-verifying"><LoaderCircle size={14} className="spin" /> 正在验证</span>}
          </div>
        </section>
      )}
      {phase === "complete" && <div className="widget-complete"><CheckCircle2 size={25} /><strong>验证完成</strong></div>}
      {phase === "error" && <button className="secondary-button widget-action" onClick={(event) => void evaluate(event.nativeEvent.isTrusted)}><RefreshCw size={17} /> 重试</button>}
      {error && <p className="inline-error" role="alert">{error}</p>}

      <footer className="widget-footer"><span>CAPTCHA SERVICE</span><span>v1</span></footer>
    </main>
  );
}
