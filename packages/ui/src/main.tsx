import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Api, takeToken } from "./api";
import "./styles.css";

const token = takeToken();
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App api={token ? new Api(token) : undefined} />
    </StrictMode>,
  );
}
