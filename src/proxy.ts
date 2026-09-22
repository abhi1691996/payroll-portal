import { NextResponse } from "next/server";
import { auth } from "@/auth";

/**
 * Optimistic routing only: signed-out users go to /login, and each portal is kept separate.
 * Real authorization happens in the backend (src/server/rbac/guard.ts) on every page, action and
 * route handler — never rely on this file for access control.
 */
export default auth((req) => {
  const { pathname } = req.nextUrl;

  if (!req.auth) {
    const loginUrl = new URL("/login", req.nextUrl.origin);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  const isSuperAdmin = req.auth.user?.superAdmin === true;
  const inPlatform = pathname === "/platform" || pathname.startsWith("/platform/");

  if (isSuperAdmin && !inPlatform) {
    return NextResponse.redirect(new URL("/platform", req.nextUrl.origin));
  }
  if (!isSuperAdmin && inPlatform) {
    return NextResponse.redirect(new URL("/dashboard", req.nextUrl.origin));
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    "/((?!api|login|accept-invite|_next/static|_next/image|favicon.ico).*)",
  ],
};
