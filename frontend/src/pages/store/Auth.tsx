import { useState } from "react";
import type { ReactNode } from "react";
import { LuEye, LuEyeOff } from "react-icons/lu";
import { api, ApiError, errorMessage } from "../../lib/api";
import { invalidate } from "../../lib/query";
import { Link, Redirect, useRouter, useSearchParams } from "../../lib/router";
import type { Session } from "../../lib/types";
import { useAuth, useConfig } from "../../state/app";
import { Alert, Button, Field } from "../../ui/core";

export function safeNext(next: string | null, fallback = "/"): string {
  // Only same-origin paths. Control characters and backslashes are rejected outright because URL
  // parsing strips or rewrites them ("/\t/evil.example" would otherwise resolve off-site).
  if (!next || !next.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(next)) return fallback;
  try {
    const url = new URL(next, window.location.origin);
    return url.origin === window.location.origin ? url.pathname + url.search + url.hash : fallback;
  } catch {
    return fallback;
  }
}

function PasswordInput(props: { id: string; value: string; onChange: (v: string) => void; autoComplete: string; "aria-invalid"?: "true"; "aria-describedby"?: string }) {
  const [show, setShow] = useState(false);
  const { onChange, ...rest } = props;
  return (
    <div className="input-reveal">
      <input className="input" type={show ? "text" : "password"} {...rest} onChange={(e) => onChange(e.target.value)} maxLength={128} required />
      <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"}>{show ? <LuEyeOff /> : <LuEye />}</button>
    </div>
  );
}

function AuthShell({ title, children, aside }: { title: string; children: ReactNode; aside: ReactNode }) {
  return (
    <div className="container page auth">
      <div className="auth__card card">
        <div className="card__body stack" style={{ "--gap": "20px" }}>
          <h1>{title}</h1>
          {children}
        </div>
      </div>
      <div className="auth__aside">{aside}</div>
    </div>
  );
}

function DemoAccounts({ fill }: { fill: (email: string, password: string) => void }) {
  const { demo_mode } = useConfig();
  if (!demo_mode) return null;
  const accounts = [
    { label: "Shopper", email: "priya@partpilot.test", password: "Demo@12345" },
    { label: "Seller", email: "lakshmi.autospares@partpilot.test", password: "Demo@12345" },
    { label: "Admin", email: "admin@partpilot.test", password: "Admin@12345" },
  ];
  return (
    <div className="demo-accounts">
      <div className="micro">Demo accounts</div>
      <div className="row row--wrap">
        {accounts.map((a) => <Button key={a.label} size="sm" onClick={() => fill(a.email, a.password)}>{a.label}</Button>)}
      </div>
    </div>
  );
}

export function LoginPage() {
  const { user, setSession } = useAuth();
  const [params] = useSearchParams();
  const { navigate } = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = safeNext(params.get("next"));
  if (user) return <Redirect to={next === "/" ? (user.role === "admin" ? "/admin" : user.role === "seller" ? "/seller" : "/") : next} />;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const session = await api.post<Session>("/api/auth/login", { email, password });
      invalidate("/api/");
      setSession(session);
      navigate(next === "/" ? (session.user?.role === "admin" ? "/admin" : session.user?.role === "seller" ? "/seller" : "/") : next, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally { setBusy(false); }
  };

  return (
    <AuthShell
      title="Sign in"
      aside={<><h2>One account for buying and selling</h2><p>Track orders, save your cars and reorder the same part in seconds. Sellers manage listings and payouts from the same sign-in.</p></>}
    >
      {error && <Alert kind="bad">{error}</Alert>}
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Email">{(p) => <input className="input" {...p} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} />}</Field>
        <Field label="Password">{(p) => <PasswordInput {...p} value={password} onChange={setPassword} autoComplete="current-password" />}</Field>
        <Button type="submit" variant="primary" size="lg" block busy={busy}>Sign in</Button>
      </form>
      <p className="small">New to PartPilot? <Link to={`/register${params.get("next") ? `?next=${encodeURIComponent(next)}` : ""}`}>Create an account</Link></p>
      <DemoAccounts fill={(e, p) => { setEmail(e); setPassword(p); }} />
    </AuthShell>
  );
}

export function RegisterPage() {
  const { user, setSession } = useAuth();
  const [params] = useSearchParams();
  const { navigate } = useRouter();
  const [form, setForm] = useState({ full_name: "", email: "", password: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = safeNext(params.get("next"));
  if (user) return <Redirect to={next} />;

  const submit = async () => {
    setBusy(true);
    setErrors({});
    setError(null);
    try {
      const session = await api.post<Session>("/api/auth/register", form);
      setSession(session);
      navigate(next, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields);
      else setError(errorMessage(err));
    } finally { setBusy(false); }
  };

  return (
    <AuthShell title="Create your account" aside={<><h2>Why an account?</h2><p>Save your cars to the garage, keep your delivery addresses, pay on delivery and return wrong-fit parts within 7 days.</p></>}>
      {error && <Alert kind="bad">{error}</Alert>}
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        <Field label="Full name" error={errors.full_name}>{(p) => <input className="input" {...p} autoComplete="name" value={form.full_name} maxLength={80} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />}</Field>
        <Field label="Email" error={errors.email}>{(p) => <input className="input" {...p} type="email" autoComplete="email" value={form.email} maxLength={254} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
        <Field label="Password" error={errors.password} hint="10+ characters with a mix of letters, numbers and symbols.">
          {(p) => <PasswordInput {...p} value={form.password} onChange={(v) => setForm({ ...form, password: v })} autoComplete="new-password" />}
        </Field>
        <Button type="submit" variant="primary" size="lg" block busy={busy}>Create account</Button>
      </form>
      <p className="small">Already have an account? <Link to="/login">Sign in</Link></p>
    </AuthShell>
  );
}
