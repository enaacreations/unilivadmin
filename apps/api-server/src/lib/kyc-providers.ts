/**
 * KYC provider adapter interface.
 *
 * Future providers (DigiLocker, Aadhaar OTP, Karza, etc.) implement this
 * interface and replace the default ManualKYCProvider. The route layer is
 * provider-agnostic — it persists the provider name and any opaque
 * providerRef / providerData returned here.
 */
export interface KYCVerifyInput {
  idType: string;
  idNumber: string;
  idImageFront?: string | null;
  idImageBack?: string | null;
  selfieImage?: string | null;
  residentName?: string;
}

export interface KYCVerifyResult {
  status: "PENDING" | "VERIFIED" | "REJECTED";
  providerRef?: string | null;
  providerData?: Record<string, unknown> | null;
  rejectionReason?: string | null;
}

export interface KYCProvider {
  name: string;
  verify(input: KYCVerifyInput): Promise<KYCVerifyResult>;
}

/**
 * Default no-op provider — leaves request in PENDING for manual admin review.
 * Real providers should perform live verification and return VERIFIED/REJECTED.
 */
export const ManualKYCProvider: KYCProvider = {
  name: "MANUAL",
  async verify() {
    return { status: "PENDING", providerRef: null, providerData: null };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// DigiLocker KYC provider (O27) — GRACEFUL DEGRADE
//
// DigiLocker uses OAuth2 (authorization-code grant). The admin/resident is sent
// to DigiLocker's authorize URL; DigiLocker redirects back to our callback with
// a `code`, which we exchange for an access token. A successful token exchange
// is treated as a verified DigiLocker identity assertion, and the KYC request is
// marked VERIFIED with provider='DIGILOCKER' and providerRef = the token/ref.
//
// None of the env vars below are required for the app to boot. When any is
// missing the provider reports unavailable (isDigiLockerConfigured() === false)
// and MANUAL remains the fallback — DigiLocker code paths never crash the app.
//
//   DIGILOCKER_CLIENT_ID     — OAuth2 client id issued by Meripehchaan/DigiLocker
//   DIGILOCKER_CLIENT_SECRET — OAuth2 client secret
//   DIGILOCKER_REDIRECT_URI  — absolute callback URL registered with DigiLocker,
//                              e.g. https://api.example.com/api/kyc/digilocker/callback
//
// Uses the Node global `fetch` (Node 18+); no SDK dependency.
// ─────────────────────────────────────────────────────────────────────────────

const DIGILOCKER_CLIENT_ID = process.env["DIGILOCKER_CLIENT_ID"];
const DIGILOCKER_CLIENT_SECRET = process.env["DIGILOCKER_CLIENT_SECRET"];
const DIGILOCKER_REDIRECT_URI = process.env["DIGILOCKER_REDIRECT_URI"];

const DIGILOCKER_AUTHORIZE_URL = "https://api.digitallocker.gov.in/public/oauth2/1/authorize";
const DIGILOCKER_TOKEN_URL = "https://api.digitallocker.gov.in/public/oauth2/1/token";

/** True only when all three DigiLocker OAuth2 env vars are present. */
export function isDigiLockerConfigured(): boolean {
  return !!DIGILOCKER_CLIENT_ID && !!DIGILOCKER_CLIENT_SECRET && !!DIGILOCKER_REDIRECT_URI;
}

/**
 * Build the DigiLocker OAuth2 authorize URL the caller should redirect to.
 * `state` is an opaque value (we use it to carry the KYC request id) that
 * DigiLocker echoes back to the callback. Returns null when not configured.
 */
export function getDigiLockerAuthorizeUrl(state: string): string | null {
  if (!isDigiLockerConfigured()) return null;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: DIGILOCKER_CLIENT_ID!,
    redirect_uri: DIGILOCKER_REDIRECT_URI!,
    state,
  });
  return `${DIGILOCKER_AUTHORIZE_URL}?${params.toString()}`;
}

export interface DigiLockerTokenResult {
  accessToken: string;
  /** Provider-side reference (digilockerid / consent ref) when returned. */
  providerRef: string | null;
  raw: Record<string, unknown>;
}

/**
 * Exchange a DigiLocker authorization `code` for an access token. Throws on a
 * missing config or a non-OK token response so the callback route can map it to
 * a 4xx/5xx; never returns a partial result.
 */
export async function exchangeDigiLockerCode(code: string): Promise<DigiLockerTokenResult> {
  if (!isDigiLockerConfigured()) {
    throw new DigiLockerNotConfiguredError();
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: DIGILOCKER_CLIENT_ID!,
    client_secret: DIGILOCKER_CLIENT_SECRET!,
    redirect_uri: DIGILOCKER_REDIRECT_URI!,
  });
  const resp = await fetch(DIGILOCKER_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`DigiLocker token exchange failed (${resp.status}): ${text.slice(0, 300)}`);
  }
  const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  const accessToken = (json["access_token"] as string | undefined) ?? "";
  if (!accessToken) {
    throw new Error("DigiLocker token exchange returned no access_token");
  }
  const providerRef =
    (json["digilockerid"] as string | undefined) ??
    (json["consent_valid_till"] as string | undefined) ??
    null;
  return { accessToken, providerRef, raw: json };
}

/** Thrown when a DigiLocker operation is attempted without credentials. */
export class DigiLockerNotConfiguredError extends Error {
  statusCode = 503 as const;
  constructor(message = "DigiLocker is not configured") {
    super(message);
    this.name = "DigiLockerNotConfiguredError";
  }
}

/**
 * DigiLocker provider. Live verification is OAuth2-redirect based and therefore
 * happens out-of-band (initiate -> DigiLocker -> callback). The synchronous
 * verify() used by the inline KYC-create path cannot complete that handshake, so
 * it gracefully degrades to PENDING (admin/resident must complete the DigiLocker
 * flow). When DigiLocker is not configured, verify() also returns PENDING so the
 * route never crashes and MANUAL remains the effective fallback.
 */
export const DigiLockerKYCProvider: KYCProvider = {
  name: "DIGILOCKER",
  async verify() {
    return {
      status: "PENDING",
      providerRef: null,
      providerData: {
        note: isDigiLockerConfigured()
          ? "Awaiting DigiLocker OAuth2 completion (initiate /kyc/:id/digilocker/initiate)."
          : "DigiLocker not configured; complete verification manually.",
      },
    };
  },
};

const PROVIDERS: Record<string, KYCProvider> = {
  MANUAL: ManualKYCProvider,
  DIGILOCKER: DigiLockerKYCProvider,
};

export function getKYCProvider(name?: string | null): KYCProvider {
  if (!name) return ManualKYCProvider;
  const key = name.toUpperCase();
  // DigiLocker only when configured; otherwise transparently fall back to MANUAL.
  if (key === "DIGILOCKER" && !isDigiLockerConfigured()) return ManualKYCProvider;
  return PROVIDERS[key] ?? ManualKYCProvider;
}
