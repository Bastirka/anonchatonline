'use strict';

// Vercel WebSocket funkcijai eksportē HTTP serveri, nevis atver lokālu portu.
const { createChatServer } = require('../server');

const chat = createChatServer();
void chat.checkDatabase();

module.exports = chat.server;

