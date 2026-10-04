import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Api, takeChosenFolder, takeToken } from "./api";
import "./styles.css";
import { applyTheme, readTheme } from "./theme";

applyTheme(readTheme());

const choseFolder = takeChosenFolder();
const token = takeToken();
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App api={token ? new Api(token) : undefined} choseFolder={choseFolder} />
    </StrictMode>,
  );
}
