// Runs before the page paints so the chosen theme never flashes the default one.
try {
  var t = localStorage.getItem('bello-theme');
  if (t) document.documentElement.setAttribute('data-theme', t);
} catch (e) {
  // Storage blocked (private mode): default theme.
}
