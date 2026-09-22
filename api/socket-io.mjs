// Vercel WebSocket beta atpazīst HTTP serveri kā ESM noklusējuma eksportu.
import serverModule from '../server.js';

const { createChatServer } = serverModule;
const chat = createChatServer();
void chat.checkDatabase();

export default chat.server;
