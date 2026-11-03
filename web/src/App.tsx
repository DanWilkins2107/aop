import { Link, Route, Routes } from "react-router-dom";
import { useLiveStatus } from "./lib/live.js";
import { GraphPage } from "./pages/GraphPage.js";
import { NodePage } from "./pages/NodePage.js";
import { ProjectsPage } from "./pages/ProjectsPage.js";

const STATUS_LABEL = { connecting: "Connecting", live: "Live", offline: "Reconnecting" };

function LiveIndicator() {
  const status = useLiveStatus();
  return (
    <span className={`live live-${status}`} title="Updates from the server">
      {STATUS_LABEL[status]}
    </span>
  );
}

export function App() {
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <svg viewBox="0 0 32 32" width="18" height="18" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="#1f2226" />
            <path d="M16 7 7 25M16 7l9 18" stroke="#ffffff" strokeWidth="4.5" />
            <circle cx="16" cy="7" r="4.5" fill="#ffc107" />
            <circle cx="7" cy="25" r="4.5" fill="#748ffc" />
            <circle cx="25" cy="25" r="4.5" fill="#20c997" />
          </svg>
          AOP
        </Link>
        <span className="topbar-spacer" />
        <LiveIndicator />
      </header>
      <main className="main">
        <Routes>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/p/:projectId" element={<GraphPage />} />
          <Route path="/n/:nodeId" element={<NodePage />} />
          <Route
            path="*"
            element={
              <div className="page">
                <h1>Page not found</h1>
                <Link to="/">Back to projects</Link>
              </div>
            }
          />
        </Routes>
      </main>
    </div>
  );
}
