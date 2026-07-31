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

export function isLoopbackAddress(address) {
  if (!address) {
    return false;
  }

  return address === "::1" || address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

export function requireLoopback(req, res, next) {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    res.status(403).json({
      error: "The DoorDash admin UI is available only from this Mac."
    });
    return;
  }

  next();
}

