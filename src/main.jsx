import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { LogOut } from "lucide-react";
import { supabase } from "./supabaseClient";
import TourenApp from "./App";

const MARINE = "#0F2A43";
const AMBER = "#F2A63C";
const BG = "#F5F6F8";
const BORDER = "#E1E6EC";
const TEXT_MUTED = "#64707C";
const DANGER = "#C4573F";
const DANGER_BG = "#FBE9E5";

// Die App hat EIN gemeinsames Login für das ganze Team (kein Konto pro
// Person) - dieses Gate fragt beim Start E-Mail/Passwort ab und hält die
// Sitzung danach über Supabase Auth aufrecht (bleibt auch nach einem
// Neuladen der Seite angemeldet, bis jemand sich aktiv abmeldet).
function LoginGate({ children }) {
  const [session, setSession] = useState(undefined); // undefined = wird noch geladen
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => listener.subscription.unsubscribe();
  }, []);

  async function handleLogin(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (err) setError("Login fehlgeschlagen: E-Mail oder Passwort falsch.");
  }

  if (session === undefined) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: TEXT_MUTED, fontFamily: "'Space Grotesk', sans-serif" }}>
        Lade …
      </div>
    );
  }

  if (!session) {
    return (
      <div style={{
        minHeight: "100vh", background: BG, display: "flex", alignItems: "center",
        justifyContent: "center", fontFamily: "'Space Grotesk', sans-serif",
      }}>
        <form onSubmit={handleLogin} style={{
          background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 12,
          padding: 32, width: 320,
        }}>
          <div style={{ color: MARINE, fontSize: 18, fontWeight: 600, marginBottom: 4 }}>Tourenliste</div>
          <div style={{ color: TEXT_MUTED, fontSize: 12.5, marginBottom: 20 }}>Gemeinsamer Team-Zugang</div>
          <label style={{ fontSize: 11, color: TEXT_MUTED, fontWeight: 500 }}>E-Mail</label>
          <input
            type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
            style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", marginTop: 4, marginBottom: 14, border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: 13 }}
          />
          <label style={{ fontSize: 11, color: TEXT_MUTED, fontWeight: 500 }}>Passwort</label>
          <input
            type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
            style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px", marginTop: 4, marginBottom: 18, border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: 13 }}
          />
          {error && (
            <div style={{ background: DANGER_BG, color: DANGER, fontSize: 12, borderRadius: 6, padding: "8px 10px", marginBottom: 14 }}>
              {error}
            </div>
          )}
          <button type="submit" disabled={loading} style={{
            width: "100%", background: AMBER, color: "#8A5A10", border: "none", borderRadius: 6,
            padding: "10px 0", fontWeight: 600, fontSize: 13.5, cursor: "pointer",
          }}>
            {loading ? "Anmelden …" : "Anmelden"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div>
      <div style={{
        display: "flex", justifyContent: "flex-end", alignItems: "center",
        gap: 8, padding: "6px 28px", background: MARINE, borderTop: "1px solid rgba(255,255,255,0.1)",
      }}>
        <span style={{ color: "#9FB3C4", fontSize: 11.5 }}>{session.user.email}</span>
        <button
          onClick={() => supabase.auth.signOut()}
          title="Abmelden"
          style={{ background: "none", border: "none", color: "#9FB3C4", cursor: "pointer", display: "flex", alignItems: "center", padding: 4 }}
        >
          <LogOut size={13} />
        </button>
      </div>
      {children}
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <LoginGate>
      <TourenApp />
    </LoginGate>
  </StrictMode>
);
