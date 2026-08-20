// Drag-to-Summarize — options page: load & save settings to chrome.storage.local.
const els = ['key', 'model', 'length', 'language'].reduce((a, id) => {
  a[id] = document.getElementById(id);
  return a;
}, {});

chrome.storage.local.get(['deepseekApiKey', 'model', 'length', 'language'], (s) => {
  els.key.value = s.deepseekApiKey || '';
  els.model.value = s.model || 'deepseek-chat';
  els.length.value = s.length || 'medium';
  els.language.value = s.language || 'English';
});

document.getElementById('save').onclick = () => {
  chrome.storage.local.set(
    {
      deepseekApiKey: els.key.value.trim(),
      model: els.model.value,
      length: els.length.value,
      language: els.language.value.trim() || 'English',
    },
    () => {
      const st = document.getElementById('status');
      st.textContent = 'Saved ✓';
      setTimeout(() => (st.textContent = ''), 1500);
    }
  );
};
