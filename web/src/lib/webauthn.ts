import {
  type AuthenticationResponseJSON,
  browserSupportsWebAuthn,
  type RegistrationResponseJSON,
  startAuthentication,
  startRegistration
} from "@simplewebauthn/browser"

type JsonRecord = Record<string, unknown>

function unwrapOptions(raw: JsonRecord): JsonRecord {
  const candidate = (raw.options ?? raw.publicKey ?? raw) as
    | JsonRecord
    | undefined
  if (!candidate || typeof candidate.challenge !== "string") {
    throw new Error("Missing WebAuthn challenge")
  }
  return candidate
}

export function webauthnSupported(): boolean {
  return typeof window !== "undefined" && browserSupportsWebAuthn()
}

export function authenticationCredential(
  raw: JsonRecord
): Promise<AuthenticationResponseJSON> {
  return startAuthentication({ optionsJSON: unwrapOptions(raw) as never })
}

export function registrationCredential(
  raw: JsonRecord
): Promise<RegistrationResponseJSON> {
  return startRegistration({ optionsJSON: unwrapOptions(raw) as never })
}

export function isWebAuthnCancelled(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name
  return name === "NotAllowedError" || name === "AbortError"
}
