/* Shared, text-only contact rendering for web and Electron workbenches. */
(function (root) {
  'use strict';
  function text(node, value) { if (node) node.textContent = value || ''; }
  function imageURL(data, base, kind) {
    var contact = (data.contacts || []).find(function (item) { return item.id === kind; });
    var value = contact && contact.qrcode_url;
    return value === '/api/product-contacts/' + data.product + '/' + kind + '/qrcode' ? new URL(value, base).href : '';
  }
  function extraFields(panel, data, base) {
    if (!panel) return;
    var old = panel.querySelector('.product-contact-extras'); if (old) old.remove();
    var box = document.createElement('div'); box.className = 'product-contact-extras';
    box.style.cssText = 'margin:0 16px 16px;font-size:12px;line-height:1.7;overflow-wrap:anywhere;display:grid;gap:8px';
    [['微信号',data.wechat_number],['电话',data.phone],['邮箱',data.email],['服务时间',data.hours],['地址',data.address]].forEach(function (pair) {
      if (!pair[1]) return; var row = document.createElement('div'); text(row, pair[0] + '：' + pair[1]); box.appendChild(row);
    });
    ['qq_contact','wechat'].forEach(function (kind) { var url=imageURL(data,base,kind); if(!url)return;var row=document.createElement('div'), img=document.createElement('img');img.src=url;img.alt=kind==='wechat'?'客服微信二维码':'客服QQ二维码';img.style.cssText='width:110px;height:110px;object-fit:contain';row.appendChild(img);box.appendChild(row); });
    if (data.join_url) { try { var url=new URL(data.join_url); if(url.protocol==='https:' && ['qm.qq.com','qun.qq.com','jq.qq.com'].includes(url.hostname) && !url.username && !url.password && (!url.port || url.port==='443')) {var a=document.createElement('a');a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';text(a,'加入 QQ 群 ↗');box.appendChild(a);} } catch (_) {} }
    if (box.childNodes.length) panel.appendChild(box);
  }
  function apply(data, base, scope) {
    scope = scope || document;
    if (!data || !data.success || !Array.isArray(data.contacts)) return false;
    // All product UI copies already read their dataset on click; update those
    // values too, so the visible number and copied/opened number cannot diverge.
    ['data-browser-contact-copy','data-window-contact-copy','data-contact-copy','data-copy-value'].forEach(function (attribute) {
      scope.querySelectorAll(attribute==='data-copy-value' ? '[data-copy-value][data-qq-kind]' : '['+attribute+']').forEach(function (button, index) {
        var kind=button.dataset.qqKind || (index%2===0?'group':'person');
        var value=kind==='group'?data.qq_group_number:data.qq_contact_number;
        var inline=button.textContent.trim()!=='复制' && button.textContent.trim()!=='复制成功';
        button.setAttribute(attribute,value||'');button.disabled=!value;
        if(inline) text(button,value || '未配置');
        var row=button.parentElement; if(row.querySelector('strong')) text(row.querySelector('strong'),value || '未配置');
        if(!inline) row.hidden=!value;
      });
    });
    scope.querySelectorAll('.browser-floating-contact-qr img,.window-floating-contact-qr img,.floating-contact-qr img,img.floating-contact-qr,.floating-contact-qr-wrap img').forEach(function (img) {
      var url=imageURL(data,base,'qq_group');img.hidden=!url;img.removeAttribute('src');if(url)img.src=url;img.alt='QQ 群 '+(data.qq_group_number||'')+' 二维码';
      var tip=img.parentElement.querySelector('span');if(tip)text(tip,url?(data.qq_group_hint||'打开 QQ 扫一扫加入群聊'):(data.qq_group_number?'请使用群号加入 QQ 群':''));
    });
    var panel=scope.querySelector('#browser-floating-contact-panel,#window-floating-contact-panel,#floating-contact-panel');
    extraFields(panel,data,base);
    return true;
  }
  async function fetchProfile(product, base) {
    var response=await fetch(new URL('/api/product-contacts/'+product,base).href,{credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw new Error('联系方式暂时无法读取');var data=await response.json();if(!data.success)throw new Error('联系方式暂时无法读取');return data;
  }
  root.MSYProductContacts={apply:apply,extraFields:extraFields,imageURL:imageURL,fetchProfile:fetchProfile};
}(typeof window !== 'undefined' ? window : globalThis));
