// Optional live check: sends one prompt to the configured model.
const base = process.env.PI_CHAT_URL || 'http://127.0.0.1:3001';
console.log('Server:', await (await fetch(`${base}/api/status`)).json());
const chat = await (await fetch(`${base}/api/chats`, { method: 'POST' })).json();
const response = await fetch(`${base}/api/chats/${chat.id}/message`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'Use the read tool to read project.txt, then summarize it briefly.' }),
});
const reader = response.body.getReader(), decoder = new TextDecoder();
let buffer = '', text = '', error;
while (true) {
  const chunk = await reader.read(); if (chunk.done) break;
  buffer += decoder.decode(chunk.value, { stream: true });
  let boundary;
  while ((boundary = buffer.indexOf('\n\n')) >= 0) {
    const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
    if (!frame.startsWith('data: ')) continue;
    const event = JSON.parse(frame.slice(6));
    if (event.type === 'delta') text += event.delta;
    if (event.type === 'tool') console.log('Tool:', event.tool.name, event.tool.status);
    if (event.type === 'error') error = event.error;
  }
}
if (error) throw new Error(error);
if (!text) throw new Error('No streamed text received.');
console.log('Live streaming reply received:', text);
