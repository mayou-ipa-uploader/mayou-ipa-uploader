(async () => {
  const product = window.appleDeveloper ? 'certificate' : 'browser';
  try {
    const result = await window.productContacts?.load(product);
    if (!result?.success) return;
    window.MSYProductContacts.apply(result.data, result.baseURL);
    document.querySelectorAll('.product-contact-extras a').forEach(link => link.addEventListener('click', event => {
      event.preventDefault(); void window.productContacts.openGroup(product);
    }));
  } catch (_) { /* Keep the bundled contact card on older/offline servers. */ }
})();
