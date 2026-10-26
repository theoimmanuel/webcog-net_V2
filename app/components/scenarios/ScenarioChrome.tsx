"use client";

// Feature: webcog-net-site
//
// Scenario chrome: the high-clutter decoration ported from the approved
// prototypes `scenario-b.html` and `scenario-c.html` (Req 7.1, 8.1).
//
// This component renders the overwhelming "SkyBook MEGA" dressing — a scrolling
// marquee, a sidebar of advertisements, countdown timers, stacking toast
// notifications, modal pop-ups, a floating chat bubble, and a cookie banner —
// around whatever booking UI is passed as `children`. It is reused by:
//   - Scenario B: static high clutter, no intervention.
//   - Scenario C: initially identical clutter that the intervention engine
//     declutters by toggling the `calm` class (see lib/load/intervention.ts,
//     CALM_CLASS = "calm").
//
// Photosensitive safety (Req 7.3, 7.4, 8.7, Property 17): ALL animation here is
// non-flashing — transforms only (translateX scroll, translateX/opacity slide-in
// of a toast's single entrance, gentle scale pulse on the chat bubble). There
// are deliberately NO opacity/visibility blink keyframes, no color cycling, and
// no shake. For the single element that genuinely toggles visibility over time
// (the "LIVE" status pip on the urgency timer), every toggle is routed through
// a shared `SafeFlash` guard, so it can never exceed 3 toggles per rolling 1 s.
//
// Decluttering (ported from scenario-c.html `body.calm`): a `.calm` ancestor
// (the engine sets it on both the scenario root and document.body) hides the
// ads/marquee/countdown/toasts/pop-ups/chat/cookie banner, removes all
// animation, simplifies the palette to a calm dark theme, enlarges body text,
// and raises contrast on the remaining booking content. The selectors below are
// written against `.calm` (not `body.calm`) so either attachment point works.
//
// prefers-reduced-motion: when the user prefers reduced motion, all chrome
// animation is disabled via a media query (Req: accessibility). Modal pop-ups
// are always dismissible by an explicit close button and a dismiss button, and
// are labelled as dialogs.

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { SafeFlash } from "@/app/components/scenarios/safeFlash";

/** Props for {@link ScenarioChrome}. */
export interface ScenarioChromeProps {
  /** The booking UI (or any main content) wrapped by the clutter chrome. */
  children: ReactNode;
  /**
   * When true (Scenario B/C before intervention) the clutter is live: pop-ups
   * appear over time and toasts stack. When false the static decoration still
   * renders but no timers run — useful for tests and SSR. Defaults to true.
   */
  animated?: boolean;
}

/** One advertisement tile in the sidebar. */
interface Ad {
  heading: string;
  body?: string;
  big?: string;
  cta: string;
  variant: 1 | 2 | 3;
}

const ADS: readonly Ad[] = [
  { heading: "WINNER!!", body: "You are visitor #1,000,000!", big: "🎉 PRIZE 🎉", cta: "CLAIM NOW", variant: 1 },
  { heading: "HOT DEAL", body: "Bali villas from Rp 1!", big: "-87%", cta: "GRAB IT", variant: 2 },
  { heading: "⏰ HURRY", body: "Only minutes left!", big: "BOOK NOW", cta: "BOOK NOW", variant: 3 },
];

/** Modal pop-up content, cycled in order (ported from the prototypes). */
const POPUPS: readonly { title: string; body: string }[] = [
  { title: "🎁 WAIT! Don't leave!", body: "Get an EXTRA 50% off if you subscribe RIGHT NOW!" },
  { title: "📧 JOIN OUR NEWSLETTER", body: "Enter your email for daily deals!" },
  { title: "🎰 SPIN TO WIN!", body: "You could win a FREE trip! (You will not win.)" },
  { title: "⚠️ LAST CHANCE!", body: "This deal expires in 3... 2... 1..." },
];

/** Fake social-proof names used by the stacking toasts. */
const TOAST_NAMES: readonly string[] = [
  "Andi from Jakarta",
  "Siti from Bandung",
  "Budi from Surabaya",
  "Rina from Medan",
  "Dewi from Bali",
];

/** Format a remaining-seconds count as mm:ss. */
function fmt(totalSeconds: number): string {
  const m = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const s = String(totalSeconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

/** A live pop-up instance on screen. */
interface LivePopup {
  id: number;
  title: string;
  body: string;
  top: number;
  left: number;
}

/** A live toast instance on screen. */
interface LiveToast {
  id: number;
  text: string;
  slot: number;
}

export default function ScenarioChrome({
  children,
  animated = true,
}: ScenarioChromeProps) {
  // Countdown shared by the sidebar + top urgency timers. Loops 4:59 -> 0:00.
  const [seconds, setSeconds] = useState(299);
  // Visibility of the "LIVE" pip on the urgency timer. Every toggle is capped
  // by SafeFlash so it can never exceed 3 flashes per rolling second.
  const [livePip, setLivePip] = useState(true);
  const [popups, setPopups] = useState<LivePopup[]>([]);
  const [toasts, setToasts] = useState<LiveToast[]>([]);
  // The cookie banner is dismissed once the participant accepts it, so it stops
  // covering the booking content (e.g. the "Confirm booking" button).
  const [cookieDismissed, setCookieDismissed] = useState(false);

  // One SafeFlash guard per mounted chrome, owning the LIVE-pip flash budget.
  const safeFlashRef = useRef<SafeFlash | null>(null);
  if (safeFlashRef.current === null) {
    safeFlashRef.current = new SafeFlash();
  }

  // Countdown tick (1 Hz). Non-visual state change; not a flash.
  useEffect(() => {
    if (!animated) return;
    const id = window.setInterval(() => {
      setSeconds((t) => (t > 0 ? t - 1 : 299));
    }, 1000);
    return () => window.clearInterval(id);
  }, [animated]);

  // "LIVE" pip toggler. It WANTS to toggle twice a second, but each toggle is
  // gated by SafeFlash (<= 3 per rolling 1 s), so the pip is photosensitive-safe
  // no matter how fast this interval fires (Req 7.3, 7.4, 8.7).
  useEffect(() => {
    if (!animated) return;
    const flash = safeFlashRef.current!;
    const id = window.setInterval(() => {
      if (flash.request()) {
        setLivePip((v) => !v);
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [animated]);

  // Modal pop-ups appearing over time (dismissible). New one every ~5 s.
  useEffect(() => {
    if (!animated) return;
    let index = 0;
    let nextId = 1;
    const id = window.setInterval(() => {
      const p = POPUPS[index % POPUPS.length];
      index += 1;
      const popup: LivePopup = {
        id: nextId++,
        title: p.title,
        body: p.body,
        top: 18 + Math.random() * 45,
        left: 18 + Math.random() * 45,
      };
      setPopups((prev) => [...prev, popup]);
    }, 5000);
    return () => window.clearInterval(id);
  }, [animated]);

  // Stacking toast notifications. New one every ~3.2 s, auto-removed after 3.5 s.
  useEffect(() => {
    if (!animated) return;
    let nextId = 1;
    let count = 0;
    const id = window.setInterval(() => {
      const toast: LiveToast = {
        id: nextId++,
        text: `✅ ${TOAST_NAMES[Math.floor(Math.random() * TOAST_NAMES.length)]} just booked a flight!`,
        slot: count % 3,
      };
      count += 1;
      setToasts((prev) => [...prev, toast]);
      const removeId = toast.id;
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== removeId));
      }, 3500);
    }, 3200);
    return () => window.clearInterval(id);
  }, [animated]);

  const dismissPopup = (id: number) => {
    setPopups((prev) => prev.filter((p) => p.id !== id));
  };

  const timer = fmt(seconds);

  return (
    <div className="chrome">
      <div className="marquee" aria-hidden="true">
        <span>
          🔥 MEGA SALE!! 90% OFF EVERYTHING!! LIMITED TIME!! BOOK NOW OR CRY
          LATER!! 🔥 FREE HOTEL!! FREE CAR!! FREE EVERYTHING!! 🔥
        </span>
      </div>

      <header className="chrome-header">
        <div className="logo">SkyBook MEGA</div>
        <ul className="nav-links">
          <li><a href="#">🔥 Flights</a></li>
          <li><a href="#">💰 Hotels</a></li>
          <li><a href="#">🎁 Deals</a></li>
          <li><a href="#">⭐ VIP</a></li>
          <li><a href="#">🎰 Lottery</a></li>
          <li><a href="#">📞 Help</a></li>
          <li><a href="#">💎 Premium</a></li>
        </ul>
      </header>

      <div className="layout">
        <aside className="sidebar" aria-hidden="true">
          {ADS.map((ad, i) => (
            <div className={`ad ad-${ad.variant}`} key={i}>
              <h4>{ad.heading}</h4>
              {ad.variant === 3 ? (
                <div className="countdown">00:{timer}</div>
              ) : (
                ad.big && <div className="big">{ad.big}</div>
              )}
              {ad.body && <p>{ad.body}</p>}
              <button type="button">{ad.cta}</button>
            </div>
          ))}
        </aside>

        <div className="main-col">
          <div className="countdown top-timer">
            <span className={`live-pip${livePip ? "" : " off"}`} aria-hidden="true" />
            OFFER ENDS IN 00:{timer} ⏰
          </div>
          {children}
        </div>
      </div>

      <div className="chat" aria-hidden="true">💬 Chat with us NOW!</div>

      {!cookieDismissed && (
        <div className="cookie" role="region" aria-label="Cookie notice">
          🍪 We use 10,000 cookies to track EVERYTHING about you!
          <button type="button" onClick={() => setCookieDismissed(true)}>
            ACCEPT ALL
          </button>
        </div>
      )}

      {/* Stacking toasts */}
      {toasts.map((t) => (
        <div
          className="toast"
          key={t.id}
          style={{ bottom: `${90 + t.slot * 70}px` }}
          role="status"
        >
          {t.text}
        </div>
      ))}

      {/* Modal pop-ups — always dismissible */}
      {popups.map((p) => (
        <div
          className="popup"
          key={p.id}
          style={{ top: `${p.top}%`, left: `${p.left}%` }}
          role="dialog"
          aria-modal="false"
          aria-label={p.title}
        >
          <button
            type="button"
            className="close"
            aria-label="Close pop-up"
            onClick={() => dismissPopup(p.id)}
          >
            ×
          </button>
          <h2>{p.title}</h2>
          <p>{p.body}</p>
          <button type="button" onClick={() => dismissPopup(p.id)}>
            No thanks
          </button>
        </div>
      ))}

      <style jsx>{`
        /* Non-flashing motion only: transforms and a single slide-in entrance. */
        @keyframes scroll {
          from { transform: translateX(100vw); }
          to { transform: translateX(-100%); }
        }
        @keyframes slidein {
          from { transform: translateX(120%); }
          to { transform: translateX(0); }
        }
        @keyframes softpulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.03); }
        }

        .chrome {
          font-family: Arial, sans-serif;
          color: #2a2a2a;
          font-size: 15px;
          line-height: 1.35;
        }

        .marquee {
          background: #c0392b;
          color: #fff;
          padding: 8px;
          white-space: nowrap;
          overflow: hidden;
          font-weight: bold;
          font-size: 17px;
        }
        .marquee span {
          display: inline-block;
          animation: scroll 20s linear infinite;
        }

        .chrome-header {
          background: #2c6e8f;
          padding: 14px;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          border-bottom: 4px solid #c0392b;
        }
        .logo {
          font-size: 28px;
          font-weight: 900;
          color: #fff;
          letter-spacing: 0.5px;
        }
        .nav-links {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          list-style: none;
          margin: 0;
          padding: 0;
        }
        .nav-links a {
          background: #fff;
          color: #2c6e8f;
          padding: 7px 11px;
          border-radius: 20px;
          text-decoration: none;
          font-weight: bold;
          font-size: 13px;
          border: 2px solid #1f4e63;
        }
        .nav-links li:nth-child(odd) a {
          background: #e67e22;
          color: #fff;
          border-color: #b35e13;
        }

        .layout {
          display: flex;
          gap: 12px;
          padding: 14px;
        }
        .sidebar {
          width: 230px;
          flex-shrink: 0;
        }
        .ad {
          background: #fff;
          border: 3px solid #c0392b;
          border-radius: 8px;
          padding: 12px;
          margin-bottom: 12px;
          text-align: center;
        }
        .ad-2 { border-color: #2c6e8f; }
        .ad-3 { border-color: #2e7d32; }
        .ad h4 { font-size: 19px; color: #c0392b; margin: 0 0 6px; }
        .ad-2 h4 { color: #2c6e8f; }
        .ad .big {
          font-size: 26px;
          font-weight: 900;
          color: #c0392b;
        }
        .ad p { margin: 6px 0; }
        .ad button {
          background: #c0392b;
          color: #fff;
          border: none;
          padding: 8px 14px;
          border-radius: 6px;
          font-weight: bold;
          cursor: pointer;
          margin-top: 6px;
        }

        .main-col { flex: 1; }

        .countdown {
          background: #2a2a2a;
          color: #f1c40f;
          font-family: monospace;
          font-size: 21px;
          padding: 8px;
          text-align: center;
          font-weight: bold;
        }
        .top-timer { margin-bottom: 12px; }

        /* The one visibility-toggling element — capped by SafeFlash in JS. */
        .live-pip {
          display: inline-block;
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: #e74c3c;
          margin-right: 8px;
          vertical-align: middle;
          opacity: 1;
          transition: opacity 0.15s ease;
        }
        .live-pip.off { opacity: 0.25; }

        .chat {
          position: fixed;
          bottom: 80px;
          right: 14px;
          background: #2c6e8f;
          color: #fff;
          border-radius: 50px;
          padding: 14px 20px;
          font-weight: bold;
          cursor: pointer;
          z-index: 850;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
          animation: softpulse 2.5s ease-in-out infinite;
        }

        .cookie {
          position: fixed;
          bottom: 0;
          left: 0;
          right: 0;
          background: #2a2a2a;
          color: #fff;
          padding: 16px;
          display: flex;
          gap: 12px;
          align-items: center;
          justify-content: center;
          flex-wrap: wrap;
          z-index: 1100;
          border-top: 4px solid #c0392b;
        }
        .cookie button {
          background: #2e7d32;
          color: #fff;
          border: none;
          padding: 10px 18px;
          font-weight: 900;
          border-radius: 6px;
          cursor: pointer;
        }

        .toast {
          position: fixed;
          right: 14px;
          background: #fff;
          color: #2a2a2a;
          border-left: 6px solid #2e7d32;
          padding: 12px 16px;
          border-radius: 6px;
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
          font-size: 13px;
          animation: slidein 0.4s ease;
          z-index: 900;
          max-width: 260px;
        }

        .popup {
          position: fixed;
          background: #fff;
          color: #2a2a2a;
          border: 4px solid #c0392b;
          border-radius: 12px;
          padding: 22px;
          z-index: 1000;
          box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.45);
          max-width: 360px;
          text-align: center;
        }
        .popup h2 { color: #c0392b; font-size: 23px; margin: 0 0 8px; }
        .popup p { margin-bottom: 12px; }
        .popup button:not(.close) {
          background: #2e7d32;
          color: #fff;
          border: 2px solid #1b5e20;
          padding: 10px 18px;
          font-weight: 900;
          border-radius: 6px;
          cursor: pointer;
        }
        .popup .close {
          position: absolute;
          top: 6px;
          right: 10px;
          background: none;
          border: none;
          font-size: 20px;
          cursor: pointer;
          color: #999;
        }

        /* Respect users who prefer reduced motion: disable all chrome motion. */
        @media (prefers-reduced-motion: reduce) {
          .marquee span,
          .chat,
          .toast {
            animation: none !important;
          }
          .live-pip { transition: none !important; }
        }

        /* ===== CALM MODE (ported from scenario-c.html body.calm) ===== */
        /* Keyed on an ancestor .calm so either the scenario root or body works. */
        :global(.calm) .chrome {
          color: #e6edf3;
          font-family: "Segoe UI", system-ui, sans-serif;
          font-size: 17px;
          line-height: 1.7;
        }
        :global(.calm) .chrome :global(*),
        :global(.calm) .chrome :global(*::before),
        :global(.calm) .chrome :global(*::after) {
          animation: none !important;
        }
        :global(.calm) .marquee,
        :global(.calm) .countdown,
        :global(.calm) .sidebar,
        :global(.calm) .chat,
        :global(.calm) .popup,
        :global(.calm) .toast,
        :global(.calm) .cookie {
          display: none !important;
        }
        :global(.calm) .chrome-header {
          background: #1a222c;
          border-bottom: 1px solid #2d3a48;
        }
        :global(.calm) .logo {
          color: #4a9eff;
          font-size: 22px;
        }
        :global(.calm) .nav-links a,
        :global(.calm) .nav-links li:nth-child(odd) a {
          background: transparent;
          color: #9aa7b4;
          border: none;
          font-weight: 400;
        }
        :global(.calm) .layout {
          max-width: 820px;
          margin: 0 auto;
          display: block;
        }
      `}</style>
    </div>
  );
}
