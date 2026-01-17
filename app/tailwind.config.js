/** @type {import('tailwindcss').Config} */
export default {
	content: ['./src/**/*.{html,js,svelte,ts}'],
	theme: {
		extend: {
			colors: {
				// Reindeer brand colors
				'reindeer-green': '#004238',
				'reindeer-green-dark': '#003329',
				'reindeer-green-light': '#00594d',
				'reindeer-cream': '#f5f3ef',
				// Terminal dark theme colors (keep these for terminal)
				'terminal-bg': '#050f0f',
				'terminal-surface': '#0a1a1a',
			},
		},
	},
	plugins: [],
};
