// Evelle staff area — shared "unsaved changes" tracking for save buttons.
// One consistent rule everywhere: a save button visibly pulses red the
// moment anything tracked changes, turns green briefly to confirm a save
// landed, and the browser blocks navigating away or closing the tab while
// something's unsaved (native confirm dialog — the only cross-browser way
// to do this; there's no way to silently swallow a tab close).
//
// Usage:
//   const tracker = staffTrackUnsaved([fieldEl1, fieldEl2, ...], saveBtnEl);
//   // inside the save button's click handler, after a successful save:
//   tracker.markSaved();
//
// Works for any input/select/textarea/checkbox. Ignores null/undefined
// entries in the fields array so callers don't need to filter first.
function staffTrackUnsaved(fields, saveBtn, opts) {
  opts = opts || {};
  let dirty = false;
  const originalText = saveBtn.textContent;

  function beforeUnloadHandler(e) {
    e.preventDefault();
    e.returnValue = '';
    return '';
  }

  function markDirty() {
    if (dirty) return;
    dirty = true;
    saveBtn.classList.remove('just-saved');
    saveBtn.classList.add('needs-save');
    saveBtn.textContent = opts.unsavedText || (originalText + ' — Unsaved');
    window.addEventListener('beforeunload', beforeUnloadHandler);
  }

  function markSaved() {
    dirty = false;
    saveBtn.classList.remove('needs-save');
    saveBtn.classList.add('just-saved');
    saveBtn.textContent = opts.savedText || 'Saved ✓';
    window.removeEventListener('beforeunload', beforeUnloadHandler);
    setTimeout(function () {
      saveBtn.classList.remove('just-saved');
      saveBtn.textContent = originalText;
    }, 1800);
  }

  // For a genuine discard (e.g. a "Cancel edit" button) — clears the
  // unsaved state without the misleading green "Saved" confirmation, since
  // nothing was actually sent to the server.
  function reset() {
    dirty = false;
    saveBtn.classList.remove('needs-save', 'just-saved');
    saveBtn.textContent = originalText;
    window.removeEventListener('beforeunload', beforeUnloadHandler);
  }

  (fields || []).forEach(function (el) {
    if (!el) return;
    const evt = (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'radio' || el.type === 'file') ? 'change' : 'input';
    el.addEventListener(evt, markDirty);
  });

  return { markDirty: markDirty, markSaved: markSaved, reset: reset, isDirty: function () { return dirty; } };
}
