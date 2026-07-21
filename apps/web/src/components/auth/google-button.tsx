import { Button } from "@/components/ui/button";
import { API_URL } from "@/lib/config";

function GoogleIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-4">
      <path
        fill="#4285F4"
        d="M19.6 10.23c0-.68-.06-1.36-.18-2.02H10v3.83h5.38a4.6 4.6 0 0 1-1.99 3.02v2.5h3.22c1.89-1.74 2.98-4.3 2.98-7.33Z"
      />
      <path
        fill="#34A853"
        d="M10 20c2.7 0 4.96-.89 6.62-2.42l-3.22-2.5c-.9.6-2.05.95-3.4.95-2.61 0-4.83-1.76-5.62-4.13H1.06v2.6A10 10 0 0 0 10 20Z"
      />
      <path
        fill="#FBBC05"
        d="M4.38 11.9a5.99 5.99 0 0 1 0-3.8v-2.6H1.06a10 10 0 0 0 0 9l3.32-2.6Z"
      />
      <path
        fill="#EA4335"
        d="M10 3.98c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.96 9.96 0 0 0 10 0 10 10 0 0 0 1.06 5.5l3.32 2.6C5.17 5.74 7.39 3.98 10 3.98Z"
      />
    </svg>
  );
}

export function GoogleButton({ next }: { next?: string }) {
  const href = `${API_URL}/auth/google${next ? `?next=${encodeURIComponent(next)}` : ""}`;

  return (
    <Button variant="outline" className="w-full" asChild>
      <a href={href}>
        <GoogleIcon />
        Continue with Google
      </a>
    </Button>
  );
}
