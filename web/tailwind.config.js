/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Calm, restrained bereavement palette (slate/sage neutrals).
        grace: {
          bg: "#f6f7f5",
          surface: "#ffffff",
          border: "#e2e4e0",
          ink: "#2b2f2c",
          muted: "#5f665f",
          accent: "#4a5c52",
          accentSoft: "#e7ede9",
          danger: "#8f2f2f",
          dangerSoft: "#f6e4e4",
          warn: "#8a6d1f",
          ok: "#3d6b4a",
        },
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};
