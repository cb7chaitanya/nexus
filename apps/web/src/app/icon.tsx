import { ImageResponse } from "next/og";

// Satori (the ImageResponse renderer) resolves colors literally, not via
// CSS custom properties — these are the computed sRGB hex values of this
// app's dark-mode --primary/--primary-foreground tokens (globals.css). If
// the accent hue is ever retuned, these need a matching manual update.
const PRIMARY = "#9e7eff";
const PRIMARY_FOREGROUND = "#090811";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
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
          borderRadius: 7,
        }}
      >
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
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
