// Applies the saved (or system) color theme before first paint. Kept as a file so the page needs no inline script.
try {
  var t = localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = t;
} catch (e) { /* storage unavailable: default light theme */ }
