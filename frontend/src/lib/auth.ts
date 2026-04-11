/**
 * Auth utilities with automatic silent token refresh.
 *
 * Flow:
 *  1. fetchWithAuth adds the Authorization header to every request.
 *  2. On 401, it silently calls POST /api/auth/refresh (uses the HttpOnly
 *     refresh-token cookie set at login) to get a new access token.
 *  3. It retries the original request once with the new token.
 *  4. If refresh itself fails (refresh token expired after 30 days),
 *     it clears the access token and hard-redirects to /login.
 *
 * Concurrent 401s: multiple requests failing at the same time share one
 * refresh call — extras wait on the same promise.
 */

export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("access_token");
}

export function setAccessToken(token: string): void {
  localStorage.setItem("access_token", token);
}

export function clearAccessToken(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem("access_token");
  document.cookie = "logged_in=; path=/; max-age=0";
}

/** Decode the JWT exp claim client-side (no signature check — timing only). */
export function getTokenExpiryMs(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** True if the token is missing or expires within `withinMs` milliseconds. */
export function isTokenExpiringSoon(token: string, withinMs = 120_000): boolean {
  const expiry = getTokenExpiryMs(token);
  if (expiry === null) return true;
  return Date.now() > expiry - withinMs;
}

// Shared promise so concurrent 401s trigger only one refresh call.
let _refreshPromise: Promise<string> | null = null;

export async function refreshAccessToken(): Promise<string> {
  if (!_refreshPromise) {
    _refreshPromise = fetch("/api/auth/refresh", { method: "POST" })
      .then((r) => {
        if (!r.ok) throw new Error("Refresh failed");
        return r.json() as Promise<{ access_token: string }>;
      })
      .then((data) => {
        setAccessToken(data.access_token);
        return data.access_token;
      })
      .finally(() => {
        _refreshPromise = null;
      });
  }
  return _refreshPromise;
}

function redirectToLogin(): void {
  clearAccessToken();
  if (typeof window !== "undefined") {
    window.location.href = "/login";
  }
}

/**
 * Drop-in replacement for fetch() that:
 *  - Adds Authorization header automatically.
 *  - Silently refreshes the access token on 401 and retries once.
 *  - Redirects to /login only if the refresh itself fails.
 */
export async function fetchWithAuth(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const token = getAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(input, { ...init, headers });
  if (res.status !== 401) return res;

  try {
    const newToken = await refreshAccessToken();
    const retryHeaders = new Headers(init.headers);
    retryHeaders.set("Authorization", `Bearer ${newToken}`);
    return fetch(input, { ...init, headers: retryHeaders });
  } catch {
    redirectToLogin();
    return res;
  }
}
