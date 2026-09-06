const CACHE='vexa-v3.1-shimmer';
const ASSETS=['./','./index.html','./manifest.json','./icon.svg','./voice-patch.js'];
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)))});
self.addEventListener('activate',e=>e.waitUntil(Promise.all([self.clients.claim(),caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))])));
self.addEventListener('fetch',e=>{
  if(e.request.mode==='navigate'){
    e.respondWith(fetch(e.request).then(async r=>{const html=await r.text();const patched=html.includes('voice-patch.js')?html:html.replace('</body>','<script src="./voice-patch.js?v=3.1"></script></body>');return new Response(patched,{status:r.status,statusText:r.statusText,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'}})}).catch(()=>caches.match('./index.html')));return;
  }
  e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)));
});