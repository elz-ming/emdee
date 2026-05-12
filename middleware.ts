import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublic = createRouteMatcher([
  "/api/index(.*)",
  "/api/doc(.*)",
  "/api/changes(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  // Doc API routes accept both Clerk sessions and PAT tokens —
  // the route handlers resolve auth themselves.
  if (isPublic(req)) return;
  await auth.protect();
});

export const config = {
  matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)", "/(api|trpc)(.*)"],
};
