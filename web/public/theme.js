(function () {
  var root = document.documentElement;
  // The app replaces the server's plain-HTML copy of the page, so skip painting it.
  root.classList.add('js');
  try {
    var t = localStorage.getItem('argonite-theme');
    if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
  } catch (e) {}
})();
