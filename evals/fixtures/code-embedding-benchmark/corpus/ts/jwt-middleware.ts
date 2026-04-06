export interface AuthenticatedRequest {
  headers: Record<string, string | undefined>;
  user?: { id: string; role: "admin" | "member" };
}

function parseBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }
  return token;
}

export async function requireJwt(
  request: AuthenticatedRequest,
  verifyToken: (
    token: string
  ) => Promise<{ sub: string; role: "admin" | "member" }>
): Promise<AuthenticatedRequest> {
  const token = parseBearerToken(request.headers.authorization);
  if (!token) {
    throw new Error("Missing bearer token");
  }

  const claims = await verifyToken(token);
  request.user = { id: claims.sub, role: claims.role };
  return request;
}
