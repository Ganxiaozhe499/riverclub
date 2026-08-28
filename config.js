// Override this value before app.js loads when the backend uses a custom domain.
// HTTPS pages require WSS. Keep the backend on its own certificate-backed subdomain.
window.RIVER_WS_URL = window.RIVER_WS_URL || 'wss://api.minicane.cn/ws';
