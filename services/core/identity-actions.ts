import {z} from "zod";
import {HttpError} from "./security.ts";

const querySchema = z
    .object({action: z.literal("recovery-codes").optional()})
    .strict();

export function identityAction(
    query: unknown,
    provider: string | undefined,
): Record<string, string> {
    const {action} = querySchema.parse(query);
    if (!action) return {};
    if (provider !== "keycloak")
        throw new HttpError(
            503,
            "Recovery-code management is not configured for this identity provider",
        );
    // No client-controlled provider actions or redirect URLs.
    return {kc_action: "CONFIGURE_RECOVERY_AUTHN_CODES"};
}
