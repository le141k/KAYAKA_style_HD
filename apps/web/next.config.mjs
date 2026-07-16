/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  experimental: {
    typedRoutes: false,
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.gravatar.com" },
      { protocol: "https", hostname: "ui-avatars.com" },
    ],
  },
  async headers() {
    const isDev = process.env.NODE_ENV !== "production";
    // The browser must be allowed to call the API origin (XHR/fetch). Derive it
    // from the same env the client uses; fall back to the local dev API.
    const apiOrigin = (() => {
      try {
        return new URL(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").origin;
      } catch {
        return "http://localhost:4000";
      }
    })();

    // D1 — Content-Security-Policy.
    // Next.js (App Router) injects inline bootstrap/RSC-streaming <script> tags and
    // styled-jsx/Tailwind inline <style>, so a strict `script-src 'self'` would break
    // hydration unless we run nonce middleware. We keep 'unsafe-inline' for script/style
    // (with 'unsafe-eval' only in dev for HMR/React-refresh) and still lock down the rest
    // (frame-ancestors, object-src, base-uri, form-action, connect-src to the API origin).
    // A nonce-based tightening of script-src is tracked as a future hardening step.
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      `connect-src 'self' ${apiOrigin}${isDev ? " ws: http://localhost:*" : ""}`,
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");

    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Content-Security-Policy", value: csp },
        ],
      },
    ];
  },
};

export default nextConfig;
