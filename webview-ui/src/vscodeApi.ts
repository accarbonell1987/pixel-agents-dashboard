// Stub — redirects to WebSocket API for standalone mode
import { sendMessage } from "./wsApi";
export const vscode = { postMessage: sendMessage };
