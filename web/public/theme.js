(function () {
  var root = document.documentElement;
  // Marks pages as running the app (styles use it to hide anything meant only for no-JavaScript visits).
  root.classList.add('js');
  try {
    var t = localStorage.getItem('argonite-theme');
    if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
  } catch (e) {}
})();
