import type { KeyKind, ModelKeyInfo } from "@alden/schema";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { Api } from "../api";
import { KEY_KIND_LABEL, KeyKindIndicator, keyKindOf } from "./ModelSetup";
import "./first-run.css";

/** The id the model picker's "Keys live in Settings · Add a key" links to: `#/settings` then this card. */
export const API_KEYS_ID = "api-keys";

const ENV: Record<KeyKind, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };

/**
 * Settings → API keys: an Anthropic or an OpenAI key (Alden tells them apart), stored in the keychain as
 * `alden auth model` does, so the desktop app (which never sees your shell's variables) can ask the model. Write-only:
 * the page never gets a key back, only where each comes from.
 */
export function ApiKeySettings(props: { api: Api; onSaved: () => void }) {
  const { api, onSaved } = props;
  const [keys, setKeys] = useState<Record<KeyKind, ModelKeyInfo | null>>();
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string }>();
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api.modelSetup().then(
      (state) => setKeys({ anthropic: state.key, openai: state.openaiKey ?? null }),
      () => setKeys(undefined),
    );
  }, [api]);
  useEffect(load, [load]);

  const change = (value: string | null, provider?: KeyKind) => {
    setBusy(true);
    setStatus(undefined);
    api
      .setModelKey(value, provider)
      .then(
        (result) => {
          const whose = KEY_KIND_LABEL[result.provider ?? provider ?? "anthropic"];
          setKey("");
          setStatus({
            tone: "ok",
            text: value === null ? `Removed the stored ${whose} key.` : `Stored your ${whose} key in your keychain.`,
          });
          load();
          onSaved();
        },
        (e: Error) => setStatus({ tone: "error", text: e.message }),
      )
      .finally(() => setBusy(false));
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (key.trim()) change(key.trim());
  };

  return (
    <form className="card panel" id={API_KEYS_ID} onSubmit={save}>
      <h2 className="label">API keys</h2>
      <p className="muted small">
        A key here goes to your keychain, like <code>alden auth model</code>, and works in the desktop app, the terminal
        and <code>alden mcp</code>. Where ANTHROPIC_API_KEY or OPENAI_API_KEY is set, it comes first.
      </p>
      <ul className="api-keys">
        {(["anthropic", "openai"] as const).map((provider) => {
          const found = keys?.[provider];
          return (
            <li key={provider}>
              <span className="api-keys-name">{KEY_KIND_LABEL[provider]}</span>
              <span className="muted small">
                {!keys ? "…" : found ? `from ${found.where}` : `none (or set ${ENV[provider]})`}
              </span>
              {found?.source === "alden" && (
                <button type="button" className="btn xs" disabled={busy} onClick={() => change(null, provider)}>
                  Remove
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <label className="field">
        <span className="key-field-head">
          Add or replace a key
          <KeyKindIndicator kind={keyKindOf(key)} />
        </span>
        <input
          className="input mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-ant-… or sk-…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <span className="help">
          Paste either kind and Alden detects it. It's never shown again, here or anywhere in Alden.
        </span>
      </label>
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy || !key.trim()}>
          Store key
        </button>
        {status && (
          <span className={status.tone === "error" ? "error-text" : "muted"} role="status">
            {status.text}
          </span>
        )}
      </div>
    </form>
  );
}
