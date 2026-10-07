/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        head: ['Oswald', 'Impact', 'sans-serif'],
      },
      colors: {
        brand: { DEFAULT: '#e11d27', dark: '#b9141d' },
        ink: '#111111',
        m1: '#fde4e4', // meal 1 / pink
        m2: '#fdf5d2', // meal 2 / yellow
        m3: '#e1f5e1', // meal 3 / green
        m4: '#e1ecfb', // meal 4 / blue
        m5: '#ede5fb', // purple
      },
    },
  },
  plugins: [],
}
