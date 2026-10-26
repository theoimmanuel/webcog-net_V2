"use client";

// Feature: webcog-net-site
//
// Scenario C — the adaptive, closed-loop decluttering scenario (Req 8, 9).
//
// Scenario C begins with clutter that is IDENTICAL to Scenario B: the same
// high-clutter `ScenarioChrome` wraps the same shared `BookingTask` (Req 8.1).
// What makes it adaptive is the closed loop around it:
//
//   active CognitiveLoadSource  ──samples──▶  AdaptiveInterventionEngine
//            (webcam or sim)                        │
//                   │                               ▼ sustained HIGH ≥ 3s
//                   └──────────▶  MonitorHUD    toggles `calm` on the root
//                                 (live display)   → ScenarioChrome declutters
//
// On every emitted LoadSample the engine's `onSample` runs the sustained-high
// detector; once a continuous HIGH run reaches 3 s the engine toggles the
// `calm` class on this scenario's root element, and `ScenarioChrome`'s ported
// `body.calm` CSS declutters the page (Req 8.2, 8.3). The source emits roughly
// one sample per second, so each inference cycle completes within 1 s and the
// state is re-evaluated every cycle.
//
// Source ownership (Req 5): the scenario subscribes to the ACTIVE source via a
// `LoadSourceController`. In the full study the harness (task 21.1) owns the
// real webcam `Vision_Pipeline` + controller + simulated trigger and injects
// them through props. For standalone use and demos, when no controller is
// provided this component constructs its own `SimulatedLoadTrigger` + controller
// and starts the simulated source, so the HUD controls work on any machine with
// no webcam. Anything this component creates/starts, it tears down on unmount.
//
// SSR-safe: the engine is created once (ref) and attached to the root element
// in an effect after mount, so no DOM is touched during server rendering.

import { useEffect, useRef, useState } from "react";
import ScenarioChrome from "@/app/components/scenarios/ScenarioChrome";
import BookingTask from "@/app/components/booking/BookingTask";
import MonitorHUD from "@/app/components/hud/MonitorHUD";
import {
  type CognitiveLoadState,
  type LoadSample,
  type LoadSourceController,
  createLoadSourceController,
} from "@/lib/load/source";
import {
  type SimulatedTrigger,
  createSimulatedTrigger,
} from "@/lib/load/simulated";
import {
  type AdaptiveInterventionEngine,
  createInterventionEngine,
} from "@/lib/load/intervention";

export interface ScenarioCProps {
  /** Called when the Booking_Task reaches confirmation (Req 11.2). */
  onComplete: () => void;
  /** Optional: called if the participant abandons before confirmation. */
  onAbandon?: () => void;
  /**
   * The active-source stream to subscribe to (Req 5.2). Injected by the harness
   * which owns the real webcam pipeline + controller (task 21.1). When omitted,
   * a local controller backed by a {@link SimulatedTrigger} is created so the
   * HUD controls work standalone.
   */
  controller?: LoadSourceController;
  /**
   * The Simulated_Trigger backing the HUD's simulate control and the reset
   * clear (Req 5.1, 8.6). Injected by the harness alongside `controller`. When
   * omitted, a local trigger is created and made the controller's active source.
   */
  simulated?: SimulatedTrigger;
}

export default function ScenarioC({
  onComplete,
  onAbandon,
  controller: controllerProp,
  simulated: simulatedProp,
}: ScenarioCProps) {
  // The scenario root the engine toggles `calm` on (Req 8.2). SSR-safe: the
  // engine is only attached to this element in an effect after mount.
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Latest sample from the active source, mirrored into state so the HUD
  // re-renders on each inference cycle (Req 9.2, Property 21).
  const [sample, setSample] = useState<LoadSample | null>(null);

  // Stable references for the controller, simulated trigger, and engine. These
  // are created once and torn down on unmount; props win when provided.
  const simulatedRef = useRef<SimulatedTrigger | null>(null);
  const controllerRef = useRef<LoadSourceController | null>(null);
  const engineRef = useRef<AdaptiveInterventionEngine | null>(null);
  // Whether this component created (and therefore must dispose/stop) the
  // controller/simulated source itself.
  const ownsLocalRef = useRef(false);

  // Resolve the simulated trigger used by the HUD controls. When the harness
  // injects one we use it; otherwise we create a local one below.
  if (simulatedRef.current === null) {
    simulatedRef.current = simulatedProp ?? createSimulatedTrigger({ initialState: "LOW" });
  }
  const simulated = simulatedRef.current;

  // Create the adaptive engine once. `clearSimulated` returns the Simulated
  // trigger to its baseline LOW state when the researcher resets the UI
  // (Req 8.6, 9.6). Guarded so a transient rejection never throws out of reset.
  if (engineRef.current === null) {
    engineRef.current = createInterventionEngine({
      adaptive: true,
      clearSimulated: () => {
        try {
          simulated.set("LOW");
        } catch {
          // A reset must always succeed; ignore any transient rejection.
        }
      },
    });
  }
  const engine = engineRef.current;

  // Wire the source/controller + subscription + engine attachment on mount.
  useEffect(() => {
    // Prefer the injected controller; otherwise build a self-contained one.
    let controller = controllerProp ?? null;
    const createdLocally = controller === null;
    ownsLocalRef.current = createdLocally;

    if (controller === null) {
      controller = createLoadSourceController();
      controller.setActiveSource(simulated);
      // Start the simulated source so it emits for the HUD + closed loop.
      void simulated.start();
    }
    controllerRef.current = controller;

    // Attach the engine to the scenario root so decluttering can toggle `calm`.
    if (rootRef.current) {
      engine.attach(rootRef.current);
    }

    // Seed the HUD with whatever the controller has already emitted.
    setSample(controller.latest());

    // Subscribe: mirror each sample into state (HUD) and drive the closed loop
    // (engine evaluates sustained-high every cycle, Req 8.2, 8.3).
    const unsubscribe = controller.subscribe((s) => {
      setSample(s);
      engine.onSample(s);
    });

    return () => {
      unsubscribe();
      // Reset the engine so the `calm` class is cleared from document.body on
      // unmount (the engine also toggles body), then tear down local resources.
      engine.reset();
      if (ownsLocalRef.current) {
        controllerRef.current?.dispose();
        simulated.stop();
      }
      controllerRef.current = null;
    };
    // Engine, simulated, and the injected controller are stable for the
    // component's lifetime; this effect intentionally runs once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Standalone demo: when we own a local simulated source, auto-ramp to HIGH a
  // few seconds in so the closed-loop intervention is visible without touching
  // the HUD (mirrors the ported scenario-c.html auto-demo). Skipped when the
  // harness injects its own controller — the real pipeline drives the loop.
  useEffect(() => {
    if (controllerProp) {
      return;
    }
    const timer = setTimeout(() => {
      try {
        simulated.set("HIGH");
      } catch {
        /* ignore — demo convenience only */
      }
    }, 6000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // HUD control handlers (Req 9.4, 9.5, 9.6).
  function handleSimulate(state: CognitiveLoadState): void {
    try {
      simulated.set(state);
    } catch {
      // Invalid states are rejected by the trigger (prior state retained);
      // the HUD only offers defined states, so this is defensive only.
    }
  }

  function handleForceDeclutter(): void {
    engine.forceDeclutter();
  }

  function handleReset(): void {
    engine.reset();
  }

  return (
    <div ref={rootRef} data-scenario="C">
      <ScenarioChrome>
        <BookingTask scenario="C" onComplete={onComplete} onAbandon={onAbandon} />
      </ScenarioChrome>

      <MonitorHUD
        sample={sample}
        onSimulate={handleSimulate}
        onForceDeclutter={handleForceDeclutter}
        onReset={handleReset}
      />
    </div>
  );
}
