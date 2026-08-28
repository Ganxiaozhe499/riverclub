// Override this value before app.js loads when the backend uses a custom domain.
// HTTPS pages require WSS; the current IP endpoint remains available for local HTTP use.
const defaultVoiceProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
window.RIVER_WS_URL = window.RIVER_WS_URL || `${defaultVoiceProtocol}//39.96.93.5:4000/ws`;
