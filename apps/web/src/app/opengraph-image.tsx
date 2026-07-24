import { ImageResponse } from "next/og";

// See icon.tsx — same computed hex values (dark-mode tokens from
// globals.css), kept in sync manually since Satori can't resolve CSS vars.
const BACKGROUND = "#080a10";
const FOREGROUND = "#f0f2f5";
const MUTED_FOREGROUND = "#777a82";
const PRIMARY = "#9e7eff";
const PRIMARY_FOREGROUND = "#090811";
const BORDER = "rgba(255,255,255,0.08)";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: BACKGROUND,
          padding: 80,
          border: `1px solid ${BORDER}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: PRIMARY,
            }}
          >
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
              <line x1="5" y1="6" x2="18.5" y2="12" stroke={PRIMARY_FOREGROUND} strokeWidth="1.4" strokeLinecap="round" />
              <line x1="5" y1="18" x2="18.5" y2="12" stroke={PRIMARY_FOREGROUND} strokeWidth="1.4" strokeLinecap="round" />
              <circle cx="5" cy="6" r="2.25" fill={PRIMARY_FOREGROUND} />
              <circle cx="5" cy="18" r="2.25" fill={PRIMARY_FOREGROUND} />
              <circle cx="19" cy="12" r="3.25" fill={PRIMARY_FOREGROUND} />
            </svg>
          </div>
          <span style={{ fontSize: 34, fontWeight: 700, color: FOREGROUND, letterSpacing: -0.5 }}>Nexus</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <span style={{ fontSize: 60, fontWeight: 700, color: FOREGROUND, letterSpacing: -1.5, lineHeight: 1.1 }}>
            The knowledge infrastructure layer for AI.
          </span>
          <span style={{ fontSize: 26, color: MUTED_FOREGROUND }}>
            Grounded, cited answers over your team&apos;s documents.
          </span>
        </div>
      </div>
    ),
    { ...size },
  );
}
