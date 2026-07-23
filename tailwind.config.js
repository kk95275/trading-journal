/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        page: '#0d0d0d',
        surface: '#1a1a19',
        raised: '#222221',
        ink: '#ffffff',
        ink2: '#c3c2b7',
        muted: '#898781',
        grid: '#2c2c2a',
        hairline: '#383835',
        up: '#0ca30c',
        down: '#d03b3b',
        accent: '#3987e5',
        accent2: '#199e70',
        warn: '#fab219',
      },
    },
  },
  plugins: [],
}
