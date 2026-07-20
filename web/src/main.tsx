import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./index.css";
import App from "./App";
import Enroll from "./routes/Enroll";
import CaseDashboard from "./routes/CaseDashboard";
import RoleplayerConsole from "./routes/demo-provider/RoleplayerConsole";
import AgentLoop from "./routes/AgentLoop";

// basename must match `base` in vite.config.ts: the backend serves "/" as the
// consumer landing page, so the dashboard lives under /admin.
const router = createBrowserRouter(
  [
    {
      path: "/",
      element: <App />,
      children: [
        { index: true, element: <Enroll /> },
        { path: "agents", element: <AgentLoop /> },
        { path: "case/:caseId", element: <CaseDashboard /> },
        { path: "demo-provider/:personaId", element: <RoleplayerConsole /> },
      ],
    },
  ],
  { basename: "/admin" }
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
