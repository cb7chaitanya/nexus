import { ImageResponse } from "next/og";

// See icon.tsx — same computed hex values, kept in sync manually.
const PRIMARY = "#9e7eff";
const PRIMARY_FOREGROUND = "#090811";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: PRIMARY,
        }}
      >
        <svg width="104" height="104" viewBox="0 0 24 24" fill="none">
          <line x1="5" y1="6" x2="18.5" y2="12" stroke={PRIMARY_FOREGROUND} strokeWidth="1.4" strokeLinecap="round" />
          <line x1="5" y1="18" x2="18.5" y2="12" stroke={PRIMARY_FOREGROUND} strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="5" cy="6" r="2.25" fill={PRIMARY_FOREGROUND} />
          <circle cx="5" cy="18" r="2.25" fill={PRIMARY_FOREGROUND} />
          <circle cx="19" cy="12" r="3.25" fill={PRIMARY_FOREGROUND} />
        </svg>
      </div>
    ),
    { ...size },
  );
}
