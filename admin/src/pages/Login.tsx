// Login screen. Fixed username/password against the backend.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { login, AdminIdentity } from "../auth";

interface Props {
  onLogin: (admin: AdminIdentity) => void;
}

export default function Login({ onLogin }: Props) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const admin = await login(username, password);
      onLogin(admin);
      nav("/", { replace: true });
    } catch (e: any) {
      setErr(e?.body?.detail ?? "Login failed. Check your credentials.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>Ride91 · Ops</h1>
        <div className="sub">Sign in to the admin panel.</div>
        <div className="row">
          <label htmlFor="u">Username</label>
          <input id="u" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoCapitalize="none" />
        </div>
        <div className="row">
          <label htmlFor="p">Password</label>
          <input id="p" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button type="submit" className="primary" disabled={busy || !username || !password} style={{ width: "100%", marginTop: 8 }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {err ? <div className="err">{err}</div> : null}
      </form>
    </div>
  );
}
