"use client";
import { useCallback, useRef } from "react";

export type DrawerState = "closed" | "peek" | "full";

interface Options {
  drawerRef: React.RefObject<HTMLDivElement | null>;
  state: DrawerState;
  setState: (s: DrawerState) => void;
}

const FLICK_VELOCITY = 0.55; // px per ms — anything above counts as a flick
const TAP_THRESHOLD = 5;     // pointer must move more than this to be a drag

/**
 * Drag-and-flick handler for the bottom-up doc drawer. Snap points are
 * keyed to the same CSS transforms used in `globals.css`:
 *   closed: translateY(100% of drawer height)
 *   peek:   translateY(drawer height - 32svh)
 *   full:   translateY(0)
 *
 * While the pointer is down we drive the drawer with an inline transform
 * (transition disabled). On release we snap to the nearest state,
 * biased by velocity: a quick flick beats raw position. A pointer that
 * never crossed the TAP_THRESHOLD is treated as a no-op so the close
 * button's onClick can still fire.
 */
export function useDrawerDrag({ drawerRef, state, setState }: Options) {
  const dragRef = useRef<{
    startY: number;
    startTranslate: number;
    lastY: number;
    lastT: number;
    pointerId: number;
    moved: boolean;
  } | null>(null);

  const getSnaps = () => {
    const vh = typeof window !== "undefined" ? window.innerHeight : 0;
    const drawerH = 0.92 * vh;
    return {
      closed: drawerH,
      peek: drawerH - 0.32 * vh,
      full: 0,
    };
  };

  const translateForState = (s: DrawerState) => {
    const snaps = getSnaps();
    return snaps[s];
  };

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const target = e.target as HTMLElement;
      // Let the close button still receive its click — don't hijack pointer
      // events that start inside it.
      if (target.closest(".mobile-drawer-close")) return;
      if (!drawerRef.current) return;
      drawerRef.current.style.transition = "none";
      dragRef.current = {
        startY: e.clientY,
        startTranslate: translateForState(state),
        lastY: e.clientY,
        lastT: performance.now(),
        pointerId: e.pointerId,
        moved: false,
      };
      try {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      } catch {}
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drawerRef, state]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      const el = drawerRef.current;
      if (!drag || !el) return;
      const dy = e.clientY - drag.startY;
      if (Math.abs(dy) > TAP_THRESHOLD) drag.moved = true;
      const snaps = getSnaps();
      const next = Math.max(snaps.full, Math.min(snaps.closed, drag.startTranslate + dy));
      el.style.transform = `translateY(${next}px)`;
      drag.lastY = e.clientY;
      drag.lastT = performance.now();
    },
    [drawerRef]
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      const el = drawerRef.current;
      if (!drag || !el) return;
      dragRef.current = null;
      el.style.transition = "";
      el.style.transform = "";
      if (!drag.moved) return; // tap: let any underlying click bubble

      const dy = e.clientY - drag.startY;
      // Recent velocity from the last move sample.
      const now = performance.now();
      const dt = now - drag.lastT;
      const recentDy = e.clientY - drag.lastY;
      const velocity = dt > 0 ? recentDy / Math.max(dt, 1) : 0;

      const finalTranslate = translateForState(state) + dy;
      const snaps = getSnaps();

      if (velocity > FLICK_VELOCITY) {
        // Flick down — step one notch closer to closed.
        if (state === "full") setState("peek");
        else if (state === "peek") setState("closed");
        return;
      }
      if (velocity < -FLICK_VELOCITY) {
        if (state === "closed") setState("peek");
        else if (state === "peek") setState("full");
        return;
      }

      // Otherwise snap to nearest of the three.
      const candidates: Array<{ s: DrawerState; d: number }> = [
        { s: "closed", d: Math.abs(finalTranslate - snaps.closed) },
        { s: "peek", d: Math.abs(finalTranslate - snaps.peek) },
        { s: "full", d: Math.abs(finalTranslate - snaps.full) },
      ];
      candidates.sort((a, b) => a.d - b.d);
      setState(candidates[0].s);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drawerRef, state, setState]
  );

  return { onPointerDown, onPointerMove, onPointerUp };
}
