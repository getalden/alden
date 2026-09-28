/** Scopes Alden asks for: `repo` to read private PRs, `read:org` to see review requests sent to your teams. */
export const GITHUB_SCOPES = ["repo", "read:org"];

/**
 * The public client ID of the getalden OAuth App (device flow enabled). Client IDs are not secrets.
 * `ALDEN_GITHUB_CLIENT_ID` overrides it for testing against another app.
 */
export const DEFAULT_GITHUB_CLIENT_ID = "Ov23liycKgR0J96Wl90H";

export function githubClientId(env: NodeJS.ProcessEnv = process.env): string {
  const id = env.ALDEN_GITHUB_CLIENT_ID?.trim() || DEFAULT_GITHUB_CLIENT_ID;
  if (!id) {
    throw new Error(
      "GitHub sign-in isn't configured yet (no OAuth App client ID). Sign in with the GitHub CLI (`gh auth login`) " +
        "and Alden will use it, or set ALDEN_GITHUB_TOKEN.",
    );
  }
  return id;
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceFlowDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const JSON_HEADERS = { Accept: "application/json", "Content-Type": "application/json" };

export async function requestDeviceCode(clientId: string, deps: DeviceFlowDeps = {}): Promise<DeviceCode> {
  const doFetch = deps.fetch ?? fetch;
  const res = await doFetch("https://github.com/login/device/code", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ client_id: clientId, scope: GITHUB_SCOPES.join(" ") }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok || typeof body.device_code !== "string") {
    throw new Error(
      `GitHub refused the sign-in request: ${String(body.error_description ?? body.error ?? res.status)}`,
    );
  }
  return {
    deviceCode: body.device_code,
    userCode: String(body.user_code),
    verificationUri: String(body.verification_uri),
    expiresIn: Number(body.expires_in),
    interval: Number(body.interval),
  };
}

/** Polls until the user approves the code in their browser, following GitHub's interval and slow_down rules. */
export async function pollForToken(clientId: string, code: DeviceCode, deps: DeviceFlowDeps = {}): Promise<string> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + code.expiresIn * 1000;
  let interval = code.interval;

  while (now() < deadline) {
    await sleep(interval * 1000);
    const res = await doFetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        client_id: clientId,
        device_code: code.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body.access_token === "string") return body.access_token;

    switch (body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval = typeof body.interval === "number" ? body.interval : interval + 5;
        continue;
      case "expired_token":
        throw new Error("The sign-in code expired. Run `alden auth login` again.");
      case "access_denied":
        throw new Error("Sign-in was cancelled in the browser.");
      default:
        throw new Error(`GitHub sign-in failed: ${String(body.error_description ?? body.error ?? res.status)}`);
    }
  }
  throw new Error("The sign-in code expired. Run `alden auth login` again.");
}
