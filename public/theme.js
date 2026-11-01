// Runs before the page paints so the chosen theme never flashes the default one.
try {
  var t = localStorage.getItem('bello-theme');
  var root = document.documentElement;
  if (t === 'auto') {
    var h = new Date().getHours();
    t = h >= 7 && h < 18 ? 'light' : 'purple';
  }
  if (t) root.setAttribute('data-theme', t);
  root.setAttribute('data-motion', localStorage.getItem('bello-motion') || 'off');
  root.setAttribute('data-bubbles', localStorage.getItem('bello-bubbles') || 'bubbles');
  root.setAttribute('data-size', localStorage.getItem('bello-size') || 'm');
  var vars = t === 'custom' && localStorage.getItem('bello-custom-vars');
  if (vars) {
    var v = JSON.parse(vars);
    for (var k in v) root.style.setProperty(k, v[k]);
  }
} catch (e) {
  // Storage blocked (private mode): default theme.
}
