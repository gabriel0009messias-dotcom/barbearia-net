// Show scroll guidance only while a table has hidden columns to the right.
(() => {
  const observed = new WeakSet();
  function update(region) {
    const note = region.previousElementSibling;
    if (!note?.classList.contains('table-scroll-note')) return;
    note.hidden = region.scrollWidth <= region.clientWidth + 1 ||
      region.scrollLeft + region.clientWidth >= region.scrollWidth - 2;
  }
  const resize = new ResizeObserver(entries => entries.forEach(({ target }) => update(target)));
  function scan() {
    document.querySelectorAll('.table-wrap').forEach(region => {
      if (!observed.has(region)) {
        observed.add(region);
        resize.observe(region);
        region.addEventListener('scroll', () => update(region), { passive: true });
      }
      update(region);
    });
  }
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', scan);
  scan();
})();
