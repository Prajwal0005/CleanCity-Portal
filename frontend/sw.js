self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const title = data.title || "Clean City Portal";
  const options = {
    body: data.body || "A complaint update is available.",
    data: { url: data.url || "/frontend/citizen.html" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data && event.notification.data.url;
  event.waitUntil(self.clients.openWindow(target || "/frontend/citizen.html"));
});
