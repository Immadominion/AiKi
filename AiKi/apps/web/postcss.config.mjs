// Tailwind v4 is no longer a PostCSS plugin itself — @tailwindcss/postcss is.
// autoprefixer and postcss-import are NOT needed; v4 does both internally.
export default { plugins: { '@tailwindcss/postcss': {} } }
