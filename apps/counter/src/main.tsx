import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { Toaster } from "./components/ui/sonner";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <Toaster />
  </StrictMode>,
);
