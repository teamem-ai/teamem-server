/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: "var(--accent)",
          strong: "var(--accent-strong)",
          soft: "var(--accent-soft)",
          "soft-2": "var(--accent-soft-2)",
        },
        surface: {
          DEFAULT: "var(--surface)",
          2: "var(--surface-2)",
          3: "var(--surface-3)",
        },
        border: {
          DEFAULT: "var(--border)",
          strong: "var(--border-strong)",
        },
        ring: "var(--ring)",
        "text-1": "var(--text)",
        "text-2": "var(--text-2)",
        "text-3": "var(--text-3)",
        "btn-bg": "var(--btn-bg)",
        "btn-bg-hover": "var(--btn-bg-hover)",
        "btn-fg": "var(--btn-fg)",
        // Semantic colors for badges
        violet: { DEFAULT: "var(--violet)", soft: "var(--violet-soft)" },
        amber: { DEFAULT: "var(--amber)", soft: "var(--amber-soft)" },
        sky: { DEFAULT: "var(--sky)", soft: "var(--sky-soft)" },
        emerald: { DEFAULT: "var(--emerald)", soft: "var(--emerald-soft)" },
        slate: { DEFAULT: "var(--slate)", soft: "var(--slate-soft)" },
        rose: { DEFAULT: "var(--rose)", soft: "var(--rose-soft)" },
        green: { DEFAULT: "var(--green)", soft: "var(--green-soft)" },
        red: { DEFAULT: "var(--red)", soft: "var(--red-soft)" },
        blue: { DEFAULT: "var(--blue)", soft: "var(--blue-soft)" },
        zinc: { DEFAULT: "var(--zinc)", soft: "var(--zinc-soft)" },
      },
      fontFamily: {
        sans: ['"Inter"', "-apple-system", "BlinkMacSystemFont", '"Segoe UI"', "Roboto", '"Helvetica Neue"', "Arial", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "Consolas", '"Liberation Mono"', "monospace"],
      },
      borderRadius: {
        sm: "var(--r-sm)",
        DEFAULT: "var(--r)",
        lg: "var(--r-lg)",
        xl: "var(--r-xl)",
      },
      boxShadow: {
        "sm": "var(--shadow-sm)",
        DEFAULT: "var(--shadow)",
        lg: "var(--shadow-lg)",
      },
      width: {
        sidebar: "252px",
      },
      height: {
        topbar: "56px",
      },
      spacing: {
        sidebar: "252px",
        topbar: "56px",
      },
    },
  },
  plugins: [],
};
