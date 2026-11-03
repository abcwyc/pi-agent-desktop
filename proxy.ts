import { NextResponse, type NextRequest } from "next/server";
import {
  getAuthRetryAfterMs,
  recordAuthFailure,
  retryAfterSeconds,
} from "@/lib/auth-throttle";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import {
  isRemoteAccessHost,
  isTailscaleFunnelRequest,
  isRemoteAccessRequestAuthorized,
  readRemoteAccessConfig,
} from "@/lib/remote-access";
import { readRelayMark } from "@/lib/relay/mark";
import {
  isValidWebSessionToken,
  isValidBasicAuthorization,
  isWebPasswordEnabled,
  PI_WEB_SESSION_COOKIE,
} from "@/lib/web-auth";

function tooManyAttempts(retryAfterMs: number): NextResponse {
  return new NextResponse("Too many failed attempts", {
    status: 429,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": String(retryAfterSeconds(retryAfterMs)),
    },
  });
}

export function proxy(request: NextRequest) {
  const isApiRequest = request.nextUrl.pathname === "/api"
    || request.nextUrl.pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)
    : isApiRequestHostAllowed(request);

  // Tailscale Funnel puts this port on the public internet. Without a web password
  // that is a shell for anyone, so refuse it however the Host header reads.
  if (isTailscaleFunnelRequest(request) && !isWebPasswordEnabled(process.env.PI_WEB_PASSWORD)) {
    return new NextResponse("Pi refuses Tailscale Funnel (public) traffic. Use tailscale serve, which keeps it inside your tailnet.", {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // A paired phone's request, replayed from 127.0.0.1 by the relay connector after
  // its Noise session authenticated the device key. Host and Origin are the
  // connector's own, and device keys take the place of the web password. A mark
  // this process did not issue is refused outright.
  const relayMark = readRelayMark(request);
  if (relayMark === "forged") {
    return isApiRequest
      ? NextResponse.json({ error: "Untrusted relay request" }, { status: 403 })
      : new NextResponse("Untrusted relay request", { status: 403 });
  }
  if (relayMark) return NextResponse.next();

  if (!isTrustedRequest) {
    // The tailnet name from Settings › Remote access, reached without a Tailscale user:
    // Funnel (public) traffic, a tagged device, or a login that is not on the list.
    const remoteAccess = readRemoteAccessConfig();
    if (remoteAccess && isRemoteAccessHost(request, remoteAccess)
      && !isRemoteAccessRequestAuthorized(request, remoteAccess)) {
      return new NextResponse("Remote access needs a signed-in Tailscale device that is allowed in Pi's settings.", {
        status: 403,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const password = process.env.PI_WEB_PASSWORD;
  if (!isWebPasswordEnabled(password)) {
    if (request.nextUrl.pathname === "/login") {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  let authenticated = isValidWebSessionToken(request.cookies.get(PI_WEB_SESSION_COOKIE)?.value, password);
  const authorization = isApiRequest ? request.headers.get("authorization") : null;
  if (!authenticated && authorization && /^Basic\s/i.test(authorization)) {
    // Every Basic header is a password guess, so it shares the login form's
    // throttle; otherwise any API path (or GET /api/web-auth) answers guesses
    // at full speed. While blocked even the right password is refused, or the
    // answer would leak. A success does not reset the counter: Basic clients
    // authenticate on every request, and each reset would hand an interleaved
    // guesser a fresh short block.
    const retryAfterMs = getAuthRetryAfterMs();
    if (retryAfterMs > 0) return tooManyAttempts(retryAfterMs);
    authenticated = isValidBasicAuthorization(authorization, password);
    if (!authenticated) recordAuthFailure();
  }
  if (request.nextUrl.pathname === "/login") {
    return authenticated
      ? NextResponse.redirect(new URL("/", request.url))
      : NextResponse.next();
  }
  if (request.nextUrl.pathname === "/api/web-auth") return NextResponse.next();

  if (!authenticated) {
    if (!isApiRequest) {
      const loginUrl = new URL("/login", request.url);
      if (request.nextUrl.search) {
        loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
      }
      return NextResponse.redirect(loginUrl);
    }
    return new NextResponse("Authentication required", {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Basic realm="Pi Web", charset="UTF-8"',
      },
    });
  }

  return NextResponse.next();
}

export const config = { matcher: ["/", "/login", "/api/:path*"] };
