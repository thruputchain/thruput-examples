import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketTransport} from '../src/transport.ts';

class Socket extends EventTarget {
  static OPEN = 1;
  static current: Socket;
  readyState = 1;
  sent: unknown[] = [];
  respond: (message: any) => void = () => {};
  constructor(_url: string | URL) {
    super(); Socket.current = this;
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }
  send(text: string) { const parsed = JSON.parse(text); this.sent.push(parsed); this.respond(parsed); }
  reply(data: unknown) { this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify(data)})); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

async function connection(t: {after(fn: () => void): void}) {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const transport = await WebSocketTransport.connect('http://127.0.0.1:9545');
  t.after(() => { transport.close(); globalThis.WebSocket = original; });
  return {transport, socket: Socket.current};
}

test('batch results retain request order when the node replies out of order', async t => {
  const {transport, socket} = await connection(t);
  socket.respond = messages => socket.reply([...messages].reverse().map(m => ({jsonrpc:'2.0',id:m.id,result:m.params[0]})));
  assert.deepEqual(await transport.batch([
    {method:'groundhog_getStorageAt',params:['meta']},
    {method:'groundhog_getStorageAt',params:['first']},
    {method:'groundhog_getStorageAt',params:['second']},
  ]), ['meta','first','second']);
  assert.equal(socket.sent.length,1);
});

test('duplicate response IDs reject the batch before delivering any frame pages', async t => {
  const {transport, socket} = await connection(t);
  socket.respond = messages => socket.reply(messages.map(() => ({jsonrpc:'2.0',id:messages[0].id,result:'invalid'})));
  await assert.rejects(transport.batch([{method:'read',params:[]},{method:'read',params:[]}]), /Invalid RPC socket/);
  assert.equal(socket.readyState,3);
});

test('an RPC error leaves the connection usable for subsequent read retries', async t => {
  const {transport, socket} = await connection(t);
  socket.respond = m => socket.reply({jsonrpc:'2.0',id:m.id,error:{code:-32050,message:'snapshot unavailable'}});
  await assert.rejects(transport.request('read'), /snapshot unavailable/);
  socket.respond = m => socket.reply({jsonrpc:'2.0',id:m.id,result:'frame'});
  assert.equal(await transport.request('read'),'frame');
});

test('losing the socket after a submission never reconnects or resubmits it', async t => {
  const {transport, socket} = await connection(t);
  socket.respond = () => socket.close();
  await assert.rejects(transport.request('groundhog_sendRawTransaction',['0xsigned']), /socket closed/);
  assert.equal(socket.sent.length,1);
  await assert.rejects(transport.request('read'), /socket is closed/);
  assert.equal(socket.sent.length,1);
});
