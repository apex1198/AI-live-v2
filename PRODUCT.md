# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are livestream operators who prepare, monitor, and control an AI avatar, voice, chat, media clips, and OBS output during a live session.

## Product Purpose

AI Idol Streamer is a local live-production control workspace. It lets one operator run an AI-led stream from a single control surface while retaining clear visibility of live state and engine health.

## Positioning

The product combines the avatar, Vietnamese voice, audience chat, playback library, and OBS bridge in one locally run operator console.

## Operating Context

The product is used under time pressure on a desktop display. Operators need to scan live state, act on chat and playback, and resolve engine issues without navigating a decorative or dense interface.

## Capabilities and Constraints

- Existing controls, runtime state, and backend API contracts must remain intact.
- The runtime is served locally at `http://127.0.0.1:6767`.
- The application includes Live, Live Settings, AI Director, and Settings workflows.
- The interface must work as web UI inside a desktop wrapper and remain functional at mobile widths.

## Brand Commitments

- Product name: AI IDOL STREAMER.
- The requested visual replacement is a dark charcoal operator interface.
- Information density must decrease; labels and display text must become more compact and easier to scan.

## Evidence on Hand

- Functional operator dashboard: `operator-dashboard/index.html`.
- Existing local runtime and engine health endpoint: `/api/engines`.
- No new factual claims, testimonials, or external visual assets are required.

## Product Principles

- Live state is legible at a glance.
- Operational actions are direct and predictable.
- Visual hierarchy favors monitoring and control over decoration.
- System feedback is explicit, compact, and calm.

## Accessibility & Inclusion

- Preserve semantic controls, labels, keyboard focus, and reduced-motion support.
- Maintain WCAG AA-oriented contrast for text and status states.
