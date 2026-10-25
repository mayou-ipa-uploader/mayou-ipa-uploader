"use strict";

function createContactService({ fetch, baseURL }) {
  const cache = new Map();
  const pending = new Map();
  async function load(product) {
    if (!['browser', 'certificate'].includes(product)) return { success: false, error: '未知产品' };
    const base = baseURL();
    const key = `${base}|${product}`;
    const previous = cache.get(key);
    if (previous && Date.now() - previous.time < 60000) return previous.result;
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      try {
        const response = await fetch(`/api/product-contacts/${product}`, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' }, cache: 'no-store' });
        const raw = await response.text();
        if (!response.ok || raw.length > 20000) throw new Error('联系方式读取失败');
        const data = JSON.parse(raw);
        if (!data.success || data.product !== product || !Array.isArray(data.contacts)) throw new Error('联系方式数据无效');
        const result = { success: true, data, baseURL: base };
        cache.set(key, { time: Date.now(), result });
        return result;
      } catch (_) { return { success: false, error: '暂时无法读取联系方式，保留已有信息' }; }
      finally { pending.delete(key); }
    })();
    pending.set(key, task);
    return task;
  }
  return { load };
}
module.exports = { createContactService };
