import { API_BASE_URL } from "./config";

export class ApiError extends Error {
  // `data` is the parsed error body, so callers can read fields the API sends
  // alongside the message (e.g. the ranked duplicate matches on a 409).
  constructor(message, status, data = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

export async function apiFetch(
  path,
  { method = "GET", body, token, responseType = "json" } = {},
) {
  let res;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("Cannot reach the server. Is the backend running?", 0);
  }

  if (!res.ok) {
    let errorData = null;

    try {
      errorData = await res.json();
    } catch (error) {
      // no JSON body
    }

    throw new ApiError(
      errorData?.message ||
        errorData?.error ||
        `Request failed (${res.status})`,
      res.status,
      errorData,
    );
  }

  const data = responseType === "blob" ? await res.blob() : await res.json();

  return data;
}
