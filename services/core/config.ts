// Validate before migrations or listening; production must never inherit local defaults.
export function validateConfiguration(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV !== "production") return;
  if (env.DEV_AUTH === "true")
    throw new Error("Development authentication forbidden in production");
  if (!env.OIDC_ISSUER)
    throw new Error("OIDC configuration required in production");
  if (env.OIDC_LOCAL_HTTP === "true" || env.OIDC_INTERNAL_ORIGIN)
    throw new Error("Local HTTP identity transport forbidden in production");
  for (const key of [
    "DATABASE_URL",
    "WEB_ORIGIN",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_REDIRECT_URI",
    "OIDC_REQUIRED_ACR",
    "OIDC_TOKEN_KEY_FILE",
  ]) {
    if (!env[key]?.trim())
      throw new Error(`${key} must be explicitly configured in production`);
  }
  if (env.OIDC_RECONCILE !== "true")
    throw new Error("Provider reconciliation must be configured in production");
  for (const value of [
    env.OIDC_ISSUER,
    env.OIDC_REDIRECT_URI!,
    ...env.WEB_ORIGIN!.split(","),
  ]) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error(
        "Production browser and identity URLs require HTTPS without credentials or fragments",
      );
  }
  if (!/^postgres(ql)?:$/.test(new URL(env.DATABASE_URL!).protocol))
    throw new Error("DATABASE_URL must use PostgreSQL");
}
