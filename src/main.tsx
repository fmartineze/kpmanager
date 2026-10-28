import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./kp.css";
import "./app.css";

// Tema del sistema: kp.css define el oscuro bajo la clase .kp-dark y se sincroniza en vivo.
const mq = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("kp-dark", mq.matches);
applyTheme();
mq.addEventListener("change", applyTheme);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
