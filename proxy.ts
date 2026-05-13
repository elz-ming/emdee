import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Public routes: no auth required.
// API routes and OAuth flows handle their own auth (PAT / OAuth tokens).
const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/api/(.*)",
  "/.well-known/(.*)",
  "/oauth/(.*)",
]);

// Protected routes (e.g. personal workspace) redirect to sign-in if not authenticated.
export default clerkMiddleware((auth, req) => {
  if (!isPublicRoute(req)) {
    auth.protect();
  }
});

export const config = {
  matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)", "/(api|trpc)(.*)"],
};
