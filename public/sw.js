// 最小限の Service Worker(PWAとしてホーム画面追加するための要件のみ。オフライン動作は非対応)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // パススルー(respondWith を呼ばなければ通常のネットワーク処理)
});
