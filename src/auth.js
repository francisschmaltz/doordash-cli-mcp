import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";

export function createTokenVerifier(securityStore) {
  return {
    async verifyAccessToken(token) {
      const record = securityStore.verifyToken(token);
      if (!record) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Unknown or revoked MCP token.");
      }

      return {
        token,
        clientId: record.id,
        scopes: record.scopes,
        expiresAt: record.expiresAt,
        extra: {
          tokenName: record.name
        }
      };
    }
  };
}

export function hasPurchaseAccess(authInfo) {
  return Boolean(authInfo?.scopes?.includes("doordash:purchase"));
}
