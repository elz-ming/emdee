"use client";
import dynamic from "next/dynamic";

const App = dynamic(() => import("./App").then(m => ({ default: m.App })), {
  ssr: false,
  loading: () => null,
});

interface AppShellProps {
  namespace: string;
}

export function AppShell({ namespace }: AppShellProps) {
  return (
    <div style={{ height: "100%", minHeight: "100svh" }}>
      <App namespace={namespace} />
    </div>
  );
}
